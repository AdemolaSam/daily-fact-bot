use anchor_lang::prelude::*;

#[account]
pub struct Agent {
    pub context: Pubkey, // the oracle's ContextAccount this agent owns
    pub task_nonce: u16, // increments on every schedule() call, drives tuktuk task_id
    pub bump: u8,
}

impl Agent {
    pub const SPACE: usize = 8   // discriminator
        + 32                      // context: Pubkey
        + 2                       // task_nonce: u16
        + 1; // bump
}

#[account]
pub struct FactLog {
    pub last_fact: String,  // GPT's response text
    pub updated_at: i64,    // timestamp of last successful callback
    pub request_count: u32, // how many times receive_fact has succeeded
    pub bump: u8,
}

impl FactLog {
    pub const MAX_FACT_LEN: usize = 400; // bytes; tune to prompt's expected output

    pub const SPACE: usize = 8            // discriminator
        + 4 + Self::MAX_FACT_LEN           // String = 4-byte len prefix + bytes
        + 8                                 // updated_at: i64
        + 4                                 // request_count: u32
        + 1; // bump
}
