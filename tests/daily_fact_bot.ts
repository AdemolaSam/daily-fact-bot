import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { Program, web3 } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { DailyFactBot } from "../target/types/daily_fact_bot";
import { init as initTuktuk, taskQueueAuthorityKey } from "@helium/tuktuk-sdk";
import path from "path";
import os from "os";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";

const ORACLE_PROGRAM_ID = new web3.PublicKey(
  "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab",
);

const TUKTUK_PROGRAM_ID = new PublicKey(
  "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA",
);

const TASK_QUEUE = new PublicKey(
  "6BMPKP4zf25ieJAfWHzyvACk87qJ2W8bA9DnrvzWHF7A",
);

describe("daily_fact_bot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  process.env.ANCHOR_PROVIDER_URL ??= "https://api.devnet.solana.com";
  process.env.ANCHOR_WALLET ??= path.join(
    os.homedir(),
    ".config",
    "solana",
    "id.json",
  );

  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.DailyFactBot as Program<DailyFactBot>;

  // ── PDA helpers ──────────────────────────────────────────────────────────

  const getCounterPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("counter")],
      ORACLE_PROGRAM_ID,
    );

  const getAgentPda = () =>
    PublicKey.findProgramAddressSync([Buffer.from("agent")], program.programId);

  const getLlmContextPda = (count: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("test-context"),
        new Uint8Array(new Uint32Array([count]).buffer),
      ],
      ORACLE_PROGRAM_ID,
    );

  const getInteractionPda = (context: web3.PublicKey, payer: web3.PublicKey) =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("interaction"), payer.toBuffer(), context.toBuffer()],
      ORACLE_PROGRAM_ID,
    );

  const getFactLogPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("fact_log")],
      program.programId,
    );

  const getQueueAuthorityPda = () =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("queue_authority")],
      program.programId,
    );

  const getRequestFactPayerPda = () =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("custom"),
        TASK_QUEUE.toBuffer(),
        Buffer.from("request_fact_payer"),
      ],
      TUKTUK_PROGRAM_ID,
    );

  // ── Utilities ────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Poll fact_log until requestCount increases above initialCount.
  // Used by both Interaction (oracle async callback) and Schedule
  // (TukTuk executes request_fact → oracle calls back receive_fact).
  // No manual cranking — TukTuk's crank network handles execution.
  async function pollUntilFactReceived(
    initialCount: number,
    timeoutMs = 240_000,
    intervalMs = 5_000,
  ) {
    const [factLogPda] = getFactLogPda();
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(intervalMs);

      let decoded: any;
      try {
        decoded = await program.account.factLog.fetch(factLogPda);
      } catch (err: any) {
        console.log("FactLog fetch failed:", err?.message ?? err);
        continue;
      }

      const currentCount = Number(decoded.requestCount ?? 0);
      const currentFact = String(decoded.lastFact ?? "").trim();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      console.log(
        `[${elapsed}s] requestCount=${currentCount}, lastFact="${currentFact.slice(
          0,
          80,
        )}${currentFact.length > 80 ? "…" : ""}"`,
      );

      if (currentCount > initialCount) {
        console.log(`Oracle callback received after ${elapsed}s`);
        return decoded;
      }
    }

    throw new Error(
      `Timed out after ${timeoutMs / 1000}s — oracle callback never arrived`,
    );
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  describe("Initialization", () => {
    it("Initializes agent and fact_log if not already created", async function () {
      this.timeout(60_000);

      const [counterPda] = getCounterPda();
      const [agentPda] = getAgentPda();
      const [factLogPda] = getFactLogPda();

      const agentInfo = await provider.connection.getAccountInfo(agentPda);
      const factLogInfo = await provider.connection.getAccountInfo(factLogPda);

      if (agentInfo && factLogInfo) {
        console.log("Agent and FactLog already initialized, skipping...");
        return;
      }

      const counterInfo = await provider.connection.getAccountInfo(counterPda);
      assert(counterInfo, "Oracle counter account not found");

      // Counter layout: 8-byte discriminator + u32 count at offset 8
      const count = counterInfo.data.readUInt32LE(8);
      const [llmContextPda] = getLlmContextPda(count);

      const tx = await program.methods
        .initialize()
        .accountsPartial({
          payer: wallet.publicKey,
          agent: agentPda,
          factLog: factLogPda,
          llmContext: llmContextPda,
          counter: counterPda,
          oracleProgram: ORACLE_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      console.log("Initialized — tx:", tx);

      // Verify both accounts exist
      const agent = await program.account.agent.fetch(agentPda);
      const factLog = await program.account.factLog.fetch(factLogPda);
      assert(agent.context, "Agent context should be set");
      assert.equal(
        Number(factLog.requestCount),
        0,
        "FactLog should start empty",
      );
      console.log("Agent context:", agent.context.toBase58());
    });
  });

  describe("Interaction", () => {
    it("Requests a fact directly from the oracle and waits for callback", async function () {
      this.timeout(300_000);

      const [agentPda] = getAgentPda();
      const [factLogPda] = getFactLogPda();

      // Fetch agent to get the LLM context this agent owns
      const agentAccount = await program.account.agent.fetch(agentPda);
      const llmContextPda = agentAccount.context;

      // Interaction PDA is scoped to (payer, context) — wallet is the payer here
      const [interactionPda] = getInteractionPda(
        llmContextPda,
        wallet.publicKey,
      );

      // Snapshot requestCount before the call so we can detect the callback
      const before = await program.account.factLog.fetch(factLogPda);
      const initialCount = Number(before.requestCount ?? 0);
      console.log("requestCount before:", initialCount);

      // Send request_fact — this does a CPI to interact_with_llm on the oracle.
      // The oracle registers the interaction and its worker will call receive_fact
      // asynchronously once it has a response.
      let tx: string;
      try {
        tx = await program.methods
          .requestFact()
          .accountsPartial({
            payer: wallet.publicKey,
            interaction: interactionPda,
            agent: agentPda,
            contextAccount: llmContextPda,
            factLog: factLogPda,
            oracleProgram: ORACLE_PROGRAM_ID,
            systemProgram: SYSTEM_PROGRAM_ID,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      } catch (err: any) {
        console.error("requestFact failed:", err);
        if (err?.logs) console.error("Logs:", err.logs);
        throw err;
      }

      console.log("requestFact tx:", tx);
      console.log("Waiting for oracle to call back receive_fact...");

      // Poll until oracle callback writes to fact_log
      const factLogData = await pollUntilFactReceived(initialCount, 240_000);

      assert(
        String(factLogData.lastFact ?? "").trim().length > 0,
        "lastFact should be populated by oracle callback",
      );
      assert.isAbove(
        Number(factLogData.requestCount),
        initialCount,
        "requestCount should have incremented",
      );
      console.log("Fact received:", factLogData.lastFact);
    });
  });

  describe("Schedule", () => {
    it("Queues a TukTuk task that triggers request_fact automatically", async function () {
      this.timeout(300_000);

      const tuktukProgram = await initTuktuk(provider);
      const [agentPda] = getAgentPda();
      const [factLogPda] = getFactLogPda();
      const [queueAuthority] = getQueueAuthorityPda();
      const [requestFactPayerPda] = getRequestFactPayerPda();

      const agentAccount = await program.account.agent.fetch(agentPda);
      const llmContextPda = agentAccount.context;

      // The scheduled request_fact is paid by TukTuk's custom payer PDA,
      // so the interaction is scoped to (requestFactPayer, context)
      const [interactionPda] = getInteractionPda(
        llmContextPda,
        requestFactPayerPda,
      );

      // Register queue authority if not already done
      const tqAuthPda = taskQueueAuthorityKey(TASK_QUEUE, queueAuthority)[0];
      const tqAuthInfo = await provider.connection.getAccountInfo(tqAuthPda);
      if (!tqAuthInfo) {
        console.log("Registering queue authority...");
        const regTx = await tuktukProgram.methods
          .addQueueAuthorityV0()
          .accounts({
            payer: wallet.publicKey,
            queueAuthority,
            taskQueue: TASK_QUEUE,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        console.log("Queue authority registered:", regTx);
      } else {
        console.log("Queue authority already registered.");
      }

      // Derive the task account for this nonce
      const taskId = agentAccount.taskNonce;
      const taskIdBuf = Buffer.alloc(2);
      taskIdBuf.writeUInt16LE(taskId);
      const [taskAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), TASK_QUEUE.toBuffer(), taskIdBuf],
        TUKTUK_PROGRAM_ID,
      );
      const [tqAuthorityPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("task_queue_authority"),
          TASK_QUEUE.toBuffer(),
          queueAuthority.toBuffer(),
        ],
        TUKTUK_PROGRAM_ID,
      );

      console.log("task_id:", taskId);
      console.log("task:", taskAccount.toBase58());
      console.log("queue_authority:", queueAuthority.toBase58());

      // Snapshot requestCount before scheduling
      const before = await program.account.factLog.fetch(factLogPda);
      const initialCount = Number(before.requestCount ?? 0);
      console.log("requestCount before:", initialCount);

      // Schedule — compiles request_fact as a TukTuk task with TriggerV0::Now.
      // TukTuk's crank network will execute it automatically — no manual cranking.
      // Once executed, the oracle worker picks up the interaction and calls receive_fact.
      let tx: string;
      try {
        tx = await program.methods
          .schedule()
          .accountsPartial({
            payer: wallet.publicKey,
            interaction: interactionPda,
            agent: agentPda,
            factLog: factLogPda,
            contextAccount: llmContextPda,
            taskQueue: TASK_QUEUE,
            taskQueueAuthority: tqAuthorityPda,
            task: taskAccount,
            queueAuthority,
            tuktukProgram: TUKTUK_PROGRAM_ID,
            systemProgram: SYSTEM_PROGRAM_ID,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      } catch (err: any) {
        console.error("schedule failed:", err);
        if (err?.logs) console.error("Logs:", err.logs);
        throw err;
      }

      console.log("schedule tx:", tx);
      console.log(
        "Waiting for TukTuk crank network to execute task, then oracle to call back receive_fact...",
      );

      // Poll until TukTuk executes request_fact and oracle callback
      // writes to fact_log — no manual cranking needed
      const factLogData = await pollUntilFactReceived(initialCount, 240_000);

      assert(
        String(factLogData.lastFact ?? "").trim().length > 0,
        "lastFact should be populated after TukTuk + oracle cycle",
      );
      assert.isAbove(
        Number(factLogData.requestCount),
        initialCount,
        "requestCount should have incremented",
      );
      console.log("Fact received:", factLogData.lastFact);
    });
  });
});
