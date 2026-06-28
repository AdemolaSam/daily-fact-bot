// import * as anchor from "@coral-xyz/anchor";
// import { assert } from "chai";
// import { Program, web3 } from "@coral-xyz/anchor";
// import type { DailyFactBot } from "../target/types/daily_fact_bot";

// const ORACLE_PROGRAM_ID = new web3.PublicKey(
//   "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab"
// );

// const TUKTUK_PROGRAM_ID = new web3.PublicKey(
//   process.env.TUKTUK_PROGRAM_ID ?? "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA"
// );

// const TUKTUK_TASK_QUEUE = new web3.PublicKey(
//   process.env.TUKTUK_TASK_QUEUE ||
//     (() => {
//       throw new Error(
//         "TUKTUK_TASK_QUEUE environment variable is required. Create the queue with tuktuk task-queue create ... and export TUKTUK_TASK_QUEUE=<queue_pubkey>"
//       );
//     })()
// );

// const REQUEST_FACT_PAYER_SEED = Buffer.from("request_fact_payer");
// const MIN_REQUEST_FACT_PAYER_LAMPORTS = 50_000_000;

// function u16Le(value: number): Buffer {
//   const buffer = Buffer.alloc(2);
//   buffer.writeUInt16LE(value, 0);
//   return buffer;
// }

// function u32Le(value: number): Buffer {
//   const buffer = Buffer.alloc(4);
//   buffer.writeUInt32LE(value, 0);
//   return buffer;
// }

// function sleep(ms: number): Promise<void> {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// async function waitForFactLogUpdate(
//   program: Program,
//   factLog: web3.PublicKey,
//   initialCount: number,
//   timeoutMs = 240_000,
//   intervalMs = 5_000
// ) {
//   const start = Date.now();
//   while (Date.now() - start < timeoutMs) {
//     const factLogAccount = await program.account.FactLog.fetch(factLog);
//     if (Number(factLogAccount.requestCount) > initialCount) {
//       return factLogAccount;
//     }
//     await sleep(intervalMs);
//   }
//   throw new Error(
//     `Timed out waiting for oracle callback after ${timeoutMs / 1000}s`
//   );
// }

// describe("daily_fact_bot devnet integration", () => {
//   const provider = anchor.AnchorProvider.env();
//   anchor.setProvider(provider);

//   const program = anchor.workspace.DailyFactBot as Program;
//   const payer = provider.wallet.publicKey;

//   const [agent] = web3.PublicKey.findProgramAddressSync(
//     [Buffer.from("agent")],
//     program.programId
//   );
//   const [factLog] = web3.PublicKey.findProgramAddressSync(
//     [Buffer.from("fact_log")],
//     program.programId
//   );
//   const [queueAuthority] = web3.PublicKey.findProgramAddressSync(
//     [Buffer.from("queue_authority")],
//     program.programId
//   );
//   const [requestFactPayer] = web3.PublicKey.findProgramAddressSync(
//     [
//       Buffer.from("custom"),
//       TUKTUK_TASK_QUEUE.toBuffer(),
//       REQUEST_FACT_PAYER_SEED,
//     ],
//     TUKTUK_PROGRAM_ID
//   );

//   async function fundIfNeeded(target: web3.PublicKey, minLamports: number) {
//     const balance = await provider.connection.getBalance(target);
//     if (balance >= minLamports) return;

//     await provider.sendAndConfirm(
//       new web3.Transaction().add(
//         web3.SystemProgram.transfer({
//           fromPubkey: payer,
//           toPubkey: target,
//           lamports: minLamports - balance,
//         })
//       )
//     );
//   }

//   it("validates the devnet TukTuk queue and authority", async () => {
//     assert.include(
//       provider.connection.rpcEndpoint,
//       "devnet",
//       `This test must run on devnet, got ${provider.connection.rpcEndpoint}`
//     );

//     const taskQueueAccount = await provider.connection.getAccountInfo(
//       TUKTUK_TASK_QUEUE
//     );
//     assert(
//       taskQueueAccount,
//       `TukTuk task queue ${TUKTUK_TASK_QUEUE.toBase58()} does not exist`
//     );
//     assert.equal(
//       taskQueueAccount.owner.toBase58(),
//       TUKTUK_PROGRAM_ID.toBase58()
//     );

//     const [taskQueueAuthority] = web3.PublicKey.findProgramAddressSync(
//       [
//         Buffer.from("task_queue_authority"),
//         TUKTUK_TASK_QUEUE.toBuffer(),
//         queueAuthority.toBuffer(),
//       ],
//       TUKTUK_PROGRAM_ID
//     );

//     const taskQueueAuthorityAccount = await provider.connection.getAccountInfo(
//       taskQueueAuthority
//     );
//     assert(
//       taskQueueAuthorityAccount,
//       "TukTuk queue authority PDA does not exist for this queue"
//     );
//   }).timeout(60000);

//   it("initializes the bot if missing", async () => {
//     const existingAgent = await provider.connection.getAccountInfo(agent);
//     if (existingAgent) {
//       console.log("Agent already initialized");
//       return;
//     }

//     const [counter] = web3.PublicKey.findProgramAddressSync(
//       [Buffer.from("counter")],
//       ORACLE_PROGRAM_ID
//     );
//     const counterAccount = await provider.connection.getAccountInfo(counter);
//     assert(
//       counterAccount,
//       "Oracle counter account not found. Is the oracle deployed on devnet?"
//     );

//     const counterCount = counterAccount.data.readUInt32LE(8);
//     const [llmContext] = web3.PublicKey.findProgramAddressSync(
//       [Buffer.from("test-context"), u32Le(counterCount)],
//       ORACLE_PROGRAM_ID
//     );

//     const tx = await program.methods
//       .initialize()
//       .accounts({
//         payer,
//         agent,
//         factLog,
//         llmContext,
//         counter,
//         systemProgram: web3.SystemProgram.programId,
//         oracleProgram: ORACLE_PROGRAM_ID,
//       })
//       .rpc();

//     console.log("Agent initialized tx:", tx);
//   }).timeout(120000);

//   it("schedules a task on TukTuk to request a daily fact", async () => {
//     await fundIfNeeded(requestFactPayer, MIN_REQUEST_FACT_PAYER_LAMPORTS);

//     const agentBefore = await program.account.Agent.fetch(agent);
//     const taskId = Number(agentBefore.taskNonce);
//     const contextAccount = agentBefore.context as web3.PublicKey;

//     const [interaction] = web3.PublicKey.findProgramAddressSync(
//       [
//         Buffer.from("interaction"),
//         requestFactPayer.toBuffer(),
//         contextAccount.toBuffer(),
//       ],
//       ORACLE_PROGRAM_ID
//     );

//     const [task] = web3.PublicKey.findProgramAddressSync(
//       [Buffer.from("task"), TUKTUK_TASK_QUEUE.toBuffer(), u16Le(taskId)],
//       TUKTUK_PROGRAM_ID
//     );

//     const [taskQueueAuthority] = web3.PublicKey.findProgramAddressSync(
//       [
//         Buffer.from("task_queue_authority"),
//         TUKTUK_TASK_QUEUE.toBuffer(),
//         queueAuthority.toBuffer(),
//       ],
//       TUKTUK_PROGRAM_ID
//     );

//     const tx = await program.methods
//       .schedule()
//       .accounts({
//         payer,
//         interaction,
//         agent,
//         contextAccount,
//         factLog,
//         taskQueue: TUKTUK_TASK_QUEUE,
//         taskQueueAuthority,
//         task,
//         queueAuthority,
//         tuktukProgram: TUKTUK_PROGRAM_ID,
//         systemProgram: web3.SystemProgram.programId,
//       })
//       .rpc();

//     console.log("Schedule tx:", tx);
//     console.log("Task account:", task.toBase58());

//     const agentAfter = await program.account.Agent.fetch(agent);
//     assert.equal(Number(agentAfter.taskNonce), (taskId + 1) & 0xffff);

//     const taskAccount = await provider.connection.getAccountInfo(task);
//     assert(taskAccount, "Expected task account to exist after schedule");
//     assert.equal(taskAccount.owner.toBase58(), TUKTUK_PROGRAM_ID.toBase58());
//   }).timeout(120000);

//   it("waits for the oracle to write the daily fact", async () => {
//     const factLogBefore = await program.account.FactLog.fetch(factLog);
//     const updated = await waitForFactLogUpdate(
//       program,
//       factLog,
//       Number(factLogBefore.requestCount)
//     );

//     assert.isNotEmpty(
//       updated.lastFact,
//       "Expected oracle to populate last_fact"
//     );
//     assert.isAbove(
//       Number(updated.requestCount),
//       Number(factLogBefore.requestCount)
//     );
//     assert.isAbove(Number(updated.updatedAt), 0);
//     console.log("Oracle fact:", updated.lastFact);
//   }).timeout(240000);
// });
