use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use constants::*;
use instructions::*;
pub use state::*;

declare_id!("CyMNpNWg1aN3ohjibVPWCtdMiKgh7o98GJG8NKnr5dwR");

#[program]
pub mod daily_fact_bot {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    pub fn request_fact(ctx: Context<RequestFact>) -> Result<()> {
        instructions::request_fact::handler(ctx)
    }

    pub fn receive_fact(ctx: Context<ReceiveFact>, response: String) -> Result<()> {
        instructions::receive_fact::handler(ctx, response)
    }

    pub fn schedule(ctx: Context<Schedule>) -> Result<()> {
        let queue_authority_bump = ctx.bumps.queue_authority;
        instructions::schedule::handler(ctx, queue_authority_bump)
    }
}