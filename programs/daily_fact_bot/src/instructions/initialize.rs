use crate::state::{Agent, FactLog};
use crate::{AGENT_SEED, FACT_LOG_SEED};
use anchor_lang::prelude::*;
use solana_gpt_oracle::Counter;

const AGENT_DESC: &str = "You are a fun-fact generator. \
    Respond with exactly one short, surprising fact. \
    Plain text only, no preamble, no markdown.";

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Agent::SPACE,
        seeds = [AGENT_SEED],
        bump
    )]
    pub agent: Account<'info, Agent>,

    #[account(
        init,
        payer = payer,
        space = FactLog::SPACE,
        seeds = [FACT_LOG_SEED],
        bump
    )]
    pub fact_log: Account<'info, FactLog>,

    /// CHECK: Checked in oracle program (oracle owns/initializes this account itself)
    #[account(mut)]
    pub llm_context: AccountInfo<'info>,

    #[account(mut)]
    pub counter: Account<'info, Counter>,

    pub system_program: Program<'info, System>,

    /// CHECK: Checked oracle id
    #[account(address = solana_gpt_oracle::ID)]
    pub oracle_program: AccountInfo<'info>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    ctx.accounts.agent.context = ctx.accounts.llm_context.key();
    ctx.accounts.agent.task_nonce = 0;
    ctx.accounts.agent.bump = ctx.bumps.agent;

    ctx.accounts.fact_log.last_fact = String::new();
    ctx.accounts.fact_log.updated_at = 0;
    ctx.accounts.fact_log.request_count = 0;
    ctx.accounts.fact_log.bump = ctx.bumps.fact_log;

    let cpi_program = ctx.accounts.oracle_program.to_account_info();
    let cpi_accounts = solana_gpt_oracle::cpi::accounts::CreateLlmContext {
        payer: ctx.accounts.payer.to_account_info(),
        context_account: ctx.accounts.llm_context.to_account_info(),
        counter: ctx.accounts.counter.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    solana_gpt_oracle::cpi::create_llm_context(cpi_ctx, AGENT_DESC.to_string())?;

    Ok(())
}
