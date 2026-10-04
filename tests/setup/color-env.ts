/**
 * Runs in every test worker before any test file imports chalk (#159).
 *
 * chalk reads FORCE_COLOR before it checks for a TTY, so a caller's
 * FORCE_COLOR=3 turned on Ink's ANSI codes and broke frame assertions that
 * match plain text. With both variables cleared, a worker resolves colour as
 * CI does: stdout is not a TTY, so chalk stays at level 0. Children spawned
 * in a real terminal (Layer 2 PTY) inherit the cleaned env and get the TTY
 * default, as in CI. NO_COLOR has no effect on chalk 5 today; it is cleared so
 * a caller's value cannot change frames once the engine honours it (#37).
 */

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
