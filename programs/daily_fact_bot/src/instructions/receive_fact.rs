use crate::constants::FACT_LOG_SEED;
use crate::error::FactBotError;
use crate::state::FactLog;
use anchor_lang::prelude::*;
use solana_gpt_oracle::Identity;

#[derive(Accounts)]
pub struct ReceiveFact<'info> {
    /// CHECK: Checked by seeds — only the oracle's identity PDA can sign this
    pub identity: Account<'info, Identity>,

    #[account(mut, seeds = [FACT_LOG_SEED], bump = fact_log.bump)]
    pub fact_log: Account<'info, FactLog>,
}

pub fn handler(ctx: Context<ReceiveFact>, response: String) -> Result<()> {
    require!(
        ctx.accounts.identity.to_account_info().is_signer,
        FactBotError::UnauthorizedCallback
    );

    let truncated: String = response.chars().take(FactLog::MAX_FACT_LEN).collect();

    let log = &mut ctx.accounts.fact_log;
    log.last_fact = truncated;
    log.updated_at = Clock::get()?.unix_timestamp;
    log.request_count = log.request_count.saturating_add(1);

    msg!("Fact received: {}", log.last_fact);
    Ok(())
}
