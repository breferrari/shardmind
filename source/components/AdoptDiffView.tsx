import { useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { diffLines } from 'diff';
import { Select } from './ui.js';

/**
 * Per-file resolution returned to the adopt state machine. Two values
 * mirror the spec's two-choice prompt — `keep_mine` records the user's
 * bytes as managed (`ownership: 'modified'`); `use_shard` overwrites
 * with the rendered/copied shard bytes.
 */
export type AdoptDiffAction = 'keep_mine' | 'use_shard';

const ADOPT_DIFF_ACTIONS = new Set<AdoptDiffAction>(['keep_mine', 'use_shard']);

const SELECT_OPTIONS = [
  { label: 'Keep mine (record my version as managed)', value: 'keep_mine' },
  { label: 'Use shard (overwrite with shard version)', value: 'use_shard' },
] as const;

/**
 * Fixed line-context budget around each diff hunk. Same value `DiffView`
 * uses for the three-way merge UI — keeping the two diff surfaces visually
 * consistent reduces cognitive load when a user adopts and then later
 * runs an update.
 */
const CONTEXT_LINES = 3;

/**
 * Cap on hunks rendered per file. A user file that diverged 200 lines
 * from the shard renders into a wall of red/green that the user can't
 * usefully read. Cap at 8 hunks; surplus collapses into a "…and N more"
 * footer. The `Select` action always works regardless of how many
 * hunks were elided.
 */
const HUNK_DISPLAY_CAP = 8;

interface AdoptDiffViewProps {
  path: string;
  index: number;
  total: number;
  shardContent: Buffer;
  userContent: Buffer;
  isBinary: boolean;
  onChoice: (action: AdoptDiffAction) => void;
}

/**
 * 2-way diff UI for `shardmind adopt`. Renders only when the planner
 * classified a file as `differs` — `matches` skip the prompt entirely
 * and `shard-only` doesn't have a user side to compare against.
 *
 * Binary fallback: when either side contains a NUL byte in the first
 * 8 KB (`AdoptClassification.isBinary` from the planner), render byte
 * sizes only. The `Select` action stays available so the user can pick
 * a side without seeing the (unrenderable) bytes.
 *
 * The `firedRef` guard mirrors `DiffView.tsx` and `CollisionReview.tsx`:
 * Ink's `Select` can fire `onChange` more than once if the instance
 * re-focuses. A double-fire on `use_shard` would queue two writes for
 * the same path; the ref clamps each mount to a single emission.
 */
export default function AdoptDiffView({
  path: filePath,
  index,
  total,
  shardContent,
  userContent,
  isBinary,
  onChoice,
}: AdoptDiffViewProps) {
  const firedRef = useRef(false);

  const hunks = useMemo(() => {
    if (isBinary) return null;
    const userText = userContent.toString('utf-8');
    const shardText = shardContent.toString('utf-8');
    return computeHunks(userText, shardText);
  }, [isBinary, shardContent, userContent]);

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color="yellow">Differs from shard: </Text>
        <Text bold>{filePath}</Text>
        <Text dimColor> ({index} of {total})</Text>
      </Box>

      {isBinary ? (
        <Box flexDirection="column">
          <Text dimColor>
            Binary file — no preview. Mine: {formatSize(userContent.length)} ·
            Shard: {formatSize(shardContent.length)}
          </Text>
        </Box>
      ) : hunks && hunks.regions.length === 0 ? (
        <Text dimColor>(No textual differences — binary newline / encoding mismatch.)</Text>
      ) : (
        <Box flexDirection="column">
          {(hunks?.regions ?? []).slice(0, HUNK_DISPLAY_CAP).map((hunk, i) => (
            <HunkBlock
              key={`${filePath}-${i}-${hunk.startLine}`}
              hunk={hunk}
              userLines={hunks!.userLines}
            />
          ))}
          {hunks && hunks.regions.length > HUNK_DISPLAY_CAP && (
            <Text dimColor>  …and {hunks.regions.length - HUNK_DISPLAY_CAP} more diff regions</Text>
          )}
        </Box>
      )}

      <Select
        key={filePath}
        options={SELECT_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
        onChange={(choice) => {
          if (firedRef.current) return;
          if (!ADOPT_DIFF_ACTIONS.has(choice as AdoptDiffAction)) return;
          firedRef.current = true;
          onChoice(choice as AdoptDiffAction);
        }}
      />
    </Box>
  );
}

interface DiffHunk {
  startLine: number;
  endLine: number;
  userSlice: string[];
  shardSlice: string[];
}

interface DiffRender {
  regions: DiffHunk[];
  userLines: string[];
}

/**
 * Walk a `diffLines` output and collapse contiguous changed runs into
 * one hunk per region. Each hunk carries:
 *   - `userSlice`: lines unique to the user side (red).
 *   - `shardSlice`: lines unique to the shard side (green).
 *   - `startLine` / `endLine`: 1-based, against the **user's** file
 *     (so the displayed line number anchors on the user's bytes the
 *     command will leave on disk if `keep_mine` is picked).
 *
 * Pure-context regions (added=removed=0) are dropped entirely so the
 * rendered output focuses on what the user has to decide about. An
 * all-context input (CRLF-only diff that the differ collapses) reports
 * zero hunks, which the parent component renders as a "no textual
 * differences" note.
 */
function computeHunks(userText: string, shardText: string): DiffRender {
  const userLines = splitLinesPreserve(userText);
  const parts = diffLines(userText, shardText);

  const regions: DiffHunk[] = [];
  let userLine = 1;

  let pendingUser: string[] = [];
  let pendingShard: string[] = [];
  let pendingStart = userLine;

  const flush = (endLine: number): void => {
    if (pendingUser.length === 0 && pendingShard.length === 0) return;
    regions.push({
      startLine: pendingStart,
      endLine,
      userSlice: pendingUser,
      shardSlice: pendingShard,
    });
    pendingUser = [];
    pendingShard = [];
  };

  for (const part of parts) {
    const lineCount = countLines(part.value);
    if (!part.added && !part.removed) {
      flush(userLine);
      userLine += lineCount;
      pendingStart = userLine;
      continue;
    }
    if (part.removed) {
      pendingUser.push(...splitLinesNoTrailing(part.value));
      userLine += lineCount;
    }
    if (part.added) {
      pendingShard.push(...splitLinesNoTrailing(part.value));
    }
  }
  flush(userLine);

  return { regions, userLines };
}

interface HunkBlockProps {
  hunk: DiffHunk;
  userLines: string[];
}

function HunkBlock({ hunk, userLines }: HunkBlockProps) {
  const beforeStart = Math.max(0, hunk.startLine - 1 - CONTEXT_LINES);
  const beforeEnd = hunk.startLine - 1;
  const afterStart = Math.min(userLines.length, hunk.endLine - 1);
  const afterEnd = Math.min(userLines.length, hunk.endLine - 1 + CONTEXT_LINES);

  const before = userLines.slice(beforeStart, beforeEnd);
  const after = userLines.slice(afterStart, afterEnd);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>lines {hunk.startLine}–{Math.max(hunk.startLine, hunk.endLine - 1)}</Text>
      {before.map((line, i) => (
        <Text key={`b-${i}`} dimColor>  {line}</Text>
      ))}
      {hunk.userSlice.length > 0 && (
        <>
          <Text color="red">&lt;&lt;&lt;&lt;&lt;&lt;&lt; mine</Text>
          {hunk.userSlice.map((line, i) => (
            <Text key={`u-${i}`} color="red">{line}</Text>
          ))}
        </>
      )}
      <Text dimColor>=======</Text>
      {hunk.shardSlice.length > 0 && (
        <>
          {hunk.shardSlice.map((line, i) => (
            <Text key={`s-${i}`} color="green">{line}</Text>
          ))}
          <Text color="green">&gt;&gt;&gt;&gt;&gt;&gt;&gt; shard</Text>
        </>
      )}
      {after.map((line, i) => (
        <Text key={`a-${i}`} dimColor>  {line}</Text>
      ))}
    </Box>
  );
}

function splitLinesPreserve(s: string): string[] {
  // Same convention `DiffView` uses: tolerate CR, accept LF.
  return s.split(/\r?\n/);
}

function splitLinesNoTrailing(s: string): string[] {
  // `diffLines` returns each chunk with a trailing newline if the source
  // had one. Strip the trailing newline (so the rendered text isn't an
  // empty extra row) but preserve any internal newlines as separate rows.
  const lines = s.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(s: string): number {
  // For the hunk-region accounting we count `\n` occurrences; the trailing
  // partial line (if the chunk doesn't end in `\n`) belongs to the same
  // region. `diffLines` always returns chunks aligned to line boundaries,
  // so this stays accurate.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n++;
  }
  return n;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
