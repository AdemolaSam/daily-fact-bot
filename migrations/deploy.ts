// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@anchor-lang/core";
import { web3 } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const TUKTUK_PROGRAM_ID = new web3.PublicKey(
  "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA",
);

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  console.log("🚀 Starting deployment...");
  console.log(`Provider: ${provider.connection.rpcEndpoint}`);
  console.log(`Wallet: ${provider.wallet.publicKey.toBase58()}`);

  // Check if we're on devnet
  const genesisHash = await provider.connection.getGenesisHash();
  const isDevnet =
    genesisHash === "EtWTRABZaYq6iMfeYKUcRjjY6EChBqqpF5RcxMJkEKG";

  if (!isDevnet) {
    throw new Error(
      `This script must run on devnet. Current genesis hash: ${genesisHash}`,
    );
  }

  // Derive the queue authority PDA
  const dailyFactBotProgram = new web3.PublicKey(
    "dVwu33nvA71Dzdp1qgAinNTxpUMUBdYJ1Ue5g32SFkn",
  );
  const [queueAuthority] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("queue_authority")],
    dailyFactBotProgram,
  );

  // Generate a new keypair for the task queue
  const taskQueueKeypair = web3.Keypair.generate();
  const taskQueue = taskQueueKeypair.publicKey;

  console.log(`\n📝 Task Queue Setup:`);
  console.log(`  Queue Authority: ${queueAuthority.toBase58()}`);
  console.log(`  Task Queue: ${taskQueue.toBase58()}`);

  // Check if queue already exists
  const existingQueue = await provider.connection.getAccountInfo(taskQueue);
  if (existingQueue) {
    console.log(`\n✅ Task queue already exists at ${taskQueue.toBase58()}`);
    console.log(
      `\nAdd this to your environment to use the existing queue:\nexport TUKTUK_TASK_QUEUE=${taskQueue.toBase58()}`,
    );
    return;
  }

  console.log(`\n⏳ Creating TukTuk task queue...`);

  // Derive the task queue authority PDA
  const [taskQueueAuthority] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("task_queue_authority"),
      taskQueue.toBuffer(),
      queueAuthority.toBuffer(),
    ],
    TUKTUK_PROGRAM_ID,
  );

  console.log(`  Task Queue Authority: ${taskQueueAuthority.toBase58()}`);

  // Get the TukTuk IDL to construct the instruction
  // For now, we'll create the queue using the raw instruction bytes
  // The TukTuk create_queue instruction typically requires:
  // - task_queue (signer, writable)
  // - queue_authority (writable)
  // - authority (signer)
  // - system_program

  const instruction = new web3.TransactionInstruction({
    programId: TUKTUK_PROGRAM_ID,
    keys: [
      { pubkey: taskQueue, isSigner: true, isWritable: true },
      { pubkey: taskQueueAuthority, isSigner: false, isWritable: true },
      { pubkey: queueAuthority, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.from([0]), // Assuming 0 is the discriminator for create_queue
  });

  const tx = new web3.Transaction().add(instruction);
  tx.feePayer = provider.wallet.publicKey;
  tx.recentBlockhash = (
    await provider.connection.getLatestBlockhash()
  ).blockhash;

  try {
    const signature = await provider.sendAndConfirm(tx, [taskQueueKeypair]);
    console.log(`✅ Task queue created! Tx: ${signature}`);
  } catch (error) {
    console.error(`⚠️  Error creating queue (may already exist):`, error);
  }

  console.log(`\n✨ Setup complete!`);
  console.log(`\nAdd this to your environment variables:`);
  console.log(`export TUKTUK_TASK_QUEUE=${taskQueue.toBase58()}`);
  console.log(`\nOr save to .env.devnet for local testing.`);
};
