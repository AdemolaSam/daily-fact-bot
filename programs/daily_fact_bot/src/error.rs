use anchor_lang::prelude::*;

#[error_code]
pub enum FactBotError {
    #[msg("Callback did not originate from the oracle's identity PDA")]
    UnauthorizedCallback,

    #[msg("Oracle response exceeded the maximum allowed fact length")]
    FactTooLong,

    #[msg("Failed to compile transaction for TukTuk task queue")]
    TransactionCompileFailed,
}
