use crate::state::{Agent, FactLog};
use crate::{AGENT_SEED, FACT_LOG_SEED};
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use solana_gpt_oracle::{AccountMeta as OracleAccountMeta, ContextAccount};

#[derive(Accounts)]
pub struct RequestFact<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Checked in oracle program
    #[account(mut)]
    pub interaction: AccountInfo<'info>,

    #[account(seeds = [AGENT_SEED], bump = agent.bump)]
    pub agent: Account<'info, Agent>,

    #[account(address = agent.context)]
    pub context_account: Account<'info, ContextAccount>,

    /// CHECK: read in callback, not written here
    #[account(mut, seeds = [FACT_LOG_SEED], bump = fact_log.bump)]
    pub fact_log: Account<'info, FactLog>,

    /// CHECK: Checked oracle id
    #[account(address = solana_gpt_oracle::ID)]
    pub oracle_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestFact>) -> Result<()> {
    let cpi_program = ctx.accounts.oracle_program.to_account_info();
    let cpi_accounts = solana_gpt_oracle::cpi::accounts::InteractWithLlm {
        payer: ctx.accounts.payer.to_account_info(),
        interaction: ctx.accounts.interaction.to_account_info(),
        context_account: ctx.accounts.context_account.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

    let disc: [u8; 8] = crate::instruction::ReceiveFact::DISCRIMINATOR
        .try_into()
        .expect("discriminator must be 8 bytes");

    let identity_pda = Pubkey::find_program_address(
        &[b"identity"],
        &solana_gpt_oracle::ID,
    ).0;

    solana_gpt_oracle::cpi::interact_with_llm(
        cpi_ctx,
        "Give me today's fun fact.".to_string(),
        crate::ID,
        disc,
        Some(vec![
            OracleAccountMeta {
                pubkey: identity_pda,
                is_signer: false,
                is_writable: false,
            },
            OracleAccountMeta {
                pubkey: ctx.accounts.fact_log.key(),
                is_signer: false,
                is_writable: true,
            },
        ]),
    )?;

    Ok(())
}
