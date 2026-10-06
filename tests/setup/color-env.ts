/**
 * Runs in every test worker before any test file imports chalk (#159).
 *
 * chalk reads FORCE_COLOR before it checks for a TTY, so a caller's
 * FORCE_COLOR=3 turned on Ink's ANSI codes and broke frame assertions that
 * match plain text. With both variables cleared, a worker resolves colour as
 * CI does: stdout is not a TTY, so chalk stays at level 0. Children spawned
 * in a real terminal (Layer 2 PTY) inherit the cleaned env and get the TTY
 * default, as in CI. NO_COLOR is cleared because the CLI honours it (#37):
 * E2E children inherit a worker's env, and a caller's NO_COLOR would strip
 * colour from their frames. TF_BUILD with AGENT_NAME (Azure Pipelines) makes
 * chalk colour even a pipe, so those go too.
 */

delete process.env['FORCE_COLOR'];
delete process.env['NO_COLOR'];
delete process.env['TF_BUILD'];
delete process.env['AGENT_NAME'];
