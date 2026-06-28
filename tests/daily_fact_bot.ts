import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { Program, web3 } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { DailyFactBot } from "../target/types/daily_fact_bot";
import {
  init as initTuktuk,
  runTask,
  taskQueueAuthorityKey,
} from "@helium/tuktuk-sdk";
import path from "path";
import os from "os";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";

const ORACLE_PROGRAM_ID = new web3.PublicKey(
  "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab"
);

const TUKTUK_PROGRAM_ID = new PublicKey(
  "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA"
);

const TASK_QUEUE = new PublicKey(
  "JCLv1EJLzgK6MQXhYEVpKSUu2APS5qiPMNCEgrcmqVNS"
);

describe("daily_fact_bot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  process.env.ANCHOR_PROVIDER_URL ??= "https://api.devnet.solana.com";
  process.env.ANCHOR_WALLET ??= path.join(
    os.homedir(),
    ".config",
    "solana",
    "id.json"
  );

  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.DailyFactBot as Program<DailyFactBot>;

  const getCounterPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("counter")],
      ORACLE_PROGRAM_ID
    );

  const getAgentPda = () =>
    PublicKey.findProgramAddressSync([Buffer.from("agent")], program.programId);

  const getLlmContextPda = (count: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("test-context"),
        new Uint8Array(new Uint32Array([count]).buffer),
      ],
      ORACLE_PROGRAM_ID
    );

  const getInteractionPda = (context: web3.PublicKey, payer: web3.PublicKey) =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("interaction"), payer.toBuffer(), context.toBuffer()],
      ORACLE_PROGRAM_ID
    );

  const getFactLogPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("fact_log")],
      program.programId
    );

  const getRequestFactPayerPda = () =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("custom"),
        TASK_QUEUE.toBuffer(),
        Buffer.from("request_fact_payer"),
      ],
      TUKTUK_PROGRAM_ID
    );

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForFactLogUpdate(
    taskAccount: PublicKey | null,
    tuktukProgram: any,
    timeoutMs = 240_000,
    intervalMs = 2_000
  ) {
    const [factLogPda] = getFactLogPda();
    const initialInfo = await provider.connection.getAccountInfo(factLogPda);
    const initialData = initialInfo
      ? (program.coder.accounts.decode("FactLog", initialInfo.data) as any)
      : null;
    const initialCount = Number(initialData?.requestCount ?? 0);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const info = await provider.connection.getAccountInfo(factLogPda);
      if (info) {
        const decoded = program.coder.accounts.decode(
          "FactLog",
          info.data
        ) as any;
        const requestCount = Number(decoded.requestCount ?? 0);
        const lastFact = String(decoded.lastFact ?? "").trim();

        if (requestCount > initialCount || lastFact.length > 0) {
          return decoded;
        }
      }

      if (taskAccount) {
        const taskInfo = await provider.connection.getAccountInfo(taskAccount);
        if (taskInfo) {
          const crankInstructions = await runTask({
            program: tuktukProgram,
            task: taskAccount,
            crankTurner: wallet.publicKey,
          });

          await provider.sendAndConfirm(
            new Transaction().add(...crankInstructions),
            [wallet.payer]
          );
        }
      }

      await sleep(intervalMs);
    }

    throw new Error(
      `Timed out waiting for the oracle callback after ${timeoutMs / 1000}s`
    );
  }

  describe("Initialization", () => {
    it("Initializes agent if not already created", async () => {
      // The oracle needs a context account and a counter account before the bot can request facts.
      const [counterPda] = getCounterPda();
      const [agentPda] = getAgentPda();
      const [factLogPda] = getFactLogPda();

      const agentInfo = await provider.connection.getAccountInfo(agentPda);
      if (agentInfo) {
        console.log("Agent already initialized, skipping...");
        return;
      }

      const counterInfo = await provider.connection.getAccountInfo(counterPda);
      assert(counterInfo, "Oracle counter account not found");

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
        .rpc();

      console.log("Agent Initialized");
      console.log("Initialize tx:", tx);
    });
  });

  const getQueueAuthorityPda = () =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("queue_authority")],
      program.programId
    );

  describe("Interaction", () => {
    it("Requests a fact directly from the oracle", async () => {
      // This covers the immediate request path and validates the oracle interaction account setup.
      const [agentPda] = getAgentPda();
      const [factLogPda] = getFactLogPda();
      const agentAccount = await program.account.agent.fetch(agentPda);

      const llmContextPda = agentAccount.context;
      const [interactionPda] = getInteractionPda(
        llmContextPda,
        wallet.publicKey
      );

      const tx = await program.methods
        .requestFact()
        .accountsPartial({
          interaction: interactionPda,
          payer: wallet.publicKey,
          factLog: factLogPda,
          systemProgram: SYSTEM_PROGRAM_ID,
          oracleProgram: ORACLE_PROGRAM_ID,
          agent: agentPda,
          contextAccount: llmContextPda,
        })
        .rpc();

      console.log("Interaction tx:", tx);
    });
  });

  describe("Schedule", () => {
    it("Schedules a TukTuk task that requests a daily fact", async () => {
      // The scheduled path uses a custom payer PDA so the queued transaction can sign and invoke request_fact.
      const tuktukProgram = await initTuktuk(provider);
      const [agentPda] = getAgentPda();
      const [queueAuthority] = getQueueAuthorityPda();
      const [factLogPda] = getFactLogPda();
      const [requestFactPayerPda] = getRequestFactPayerPda();

      console.log("Queue authority:", queueAuthority.toBase58());

      const agentAccount = await program.account.agent.fetch(agentPda);
      const llmContextPda = agentAccount.context;
      const [interactionPda] = getInteractionPda(
        llmContextPda,
        requestFactPayerPda
      );

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
        console.log("Registered:", regTx);
      } else {
        console.log("Queue authority already registered.");
      }

      const taskId = agentAccount.taskNonce;
      const taskIdBuf = Buffer.alloc(2);
      taskIdBuf.writeUInt16LE(taskId);
      const [taskAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), TASK_QUEUE.toBuffer(), taskIdBuf],
        TUKTUK_PROGRAM_ID
      );
      const [tqAuthorityPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("task_queue_authority"),
          TASK_QUEUE.toBuffer(),
          queueAuthority.toBuffer(),
        ],
        TUKTUK_PROGRAM_ID
      );

      console.log("task_id:", taskId);
      console.log("task:", taskAccount.toBase58());

      const tx = await program.methods
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

      console.log("Schedule tx:", tx);

      const factLogData = await waitForFactLogUpdate(
        taskAccount,
        tuktukProgram
      );
      assert(
        String(factLogData.lastFact ?? "").trim().length > 0,
        "Expected the oracle callback to populate the fact log"
      );
      assert.isAbove(Number(factLogData.requestCount ?? 0), 0);
      console.log("Fact Log:", factLogData);
    });
  });
});
