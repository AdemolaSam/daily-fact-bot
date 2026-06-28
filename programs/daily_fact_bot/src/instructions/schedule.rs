use crate::state::{Agent, FactLog};
use crate::{AGENT_SEED, FACT_LOG_SEED, QUEUE_AUTHORITY_SEED, REQUEST_FACT_PAYER_SEED};
use anchor_lang::{
    prelude::{instruction::Instruction, *},
    InstructionData,
};
use solana_gpt_oracle::ContextAccount;
use tuktuk_program::{
    compile_transaction,
    tuktuk::{cpi::queue_task_v0, program::Tuktuk},
    TransactionSourceV0, TriggerV0,
};

#[derive(Accounts)]
pub struct Schedule<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Checked in oracle program
    #[account(mut)]
    pub interaction: AccountInfo<'info>,

    #[account(mut, seeds = [AGENT_SEED], bump = agent.bump)]
    pub agent: Account<'info, Agent>,

    #[account(address = agent.context)]
    pub context_account: Account<'info, ContextAccount>,

    #[account(seeds = [FACT_LOG_SEED], bump = fact_log.bump)]
    pub fact_log: Account<'info, FactLog>,

    /// CHECK: Passed through to TukTuk CPI
    #[account(mut)]
    pub task_queue: UncheckedAccount<'info>,

    /// CHECK: Derived and verified by TukTuk program
    #[account(mut)]
    pub task_queue_authority: UncheckedAccount<'info>,

    /// CHECK: Initialized in CPI - address = PDA(["task", task_queue, task_id], tuktuk)
    #[account(mut)]
    pub task: UncheckedAccount<'info>,

    /// CHECK: PDA signer - no data stored here
    #[account(mut, seeds = [QUEUE_AUTHORITY_SEED], bump)]
    pub queue_authority: AccountInfo<'info>,

    pub tuktuk_program: Program<'info, Tuktuk>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Schedule>, queue_authority_bump: u8) -> Result<()> {
    let task_id = ctx.accounts.agent.task_nonce;
    ctx.accounts.agent.task_nonce = ctx.accounts.agent.task_nonce.wrapping_add(1);

    let (request_fact_payer, _) = Pubkey::find_program_address(
        &[
            b"custom",
            ctx.accounts.task_queue.key().as_ref(),
            REQUEST_FACT_PAYER_SEED,
        ],
        &ctx.accounts.tuktuk_program.key(),
    );

    let request_fact_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new(request_fact_payer, true),
            AccountMeta::new(ctx.accounts.interaction.key(), false),
            AccountMeta::new_readonly(ctx.accounts.agent.key(), false),
            AccountMeta::new_readonly(ctx.accounts.context_account.key(), false),
            AccountMeta::new(ctx.accounts.fact_log.key(), false),
            AccountMeta::new_readonly(solana_gpt_oracle::ID, false),
            AccountMeta::new_readonly(System::id(), false),
        ],
        data: crate::instruction::RequestFact {}.data(),
    };

    let (compiled_tx, _) = compile_transaction(
        vec![request_fact_ix],
        vec![vec![REQUEST_FACT_PAYER_SEED.to_vec()]],
    )
    .map_err(|_| error!(crate::error::FactBotError::TransactionCompileFailed))?;

    queue_task_v0(
        CpiContext::new_with_signer(
            ctx.accounts.tuktuk_program.to_account_info(),
            tuktuk_program::tuktuk::cpi::accounts::QueueTaskV0 {
                payer: ctx.accounts.payer.to_account_info(),
                queue_authority: ctx.accounts.queue_authority.to_account_info(),
                task_queue: ctx.accounts.task_queue.to_account_info(),
                task_queue_authority: ctx.accounts.task_queue_authority.to_account_info(),
                task: ctx.accounts.task.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[&[QUEUE_AUTHORITY_SEED, &[queue_authority_bump]]],
        ),
        tuktuk_program::types::QueueTaskArgsV0 {
            id: task_id,
            trigger: TriggerV0::Now,
            transaction: TransactionSourceV0::CompiledV0(compiled_tx),
            crank_reward: Some(5_000_000),
            free_tasks: 0,
            description: "request_fact".to_string(),
        },
    )?;

    Ok(())
}
