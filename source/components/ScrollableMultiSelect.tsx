import { useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

export interface ScrollableMultiSelectOption {
  label: string;
  value: string;
}

export interface ScrollableMultiSelectProps {
  options: ScrollableMultiSelectOption[];
  defaultValue?: string[];
  visibleOptionCount?: number;
  onChange?: (selected: string[]) => void;
  onSubmit?: (selected: string[]) => void;
  isDisabled?: boolean;
}

/**
 * Multi-select with scroll indicators. Mirrors @inkjs/ui's MultiSelect
 * keyboard model (↑↓ navigate, space toggles, Enter submits) but renders
 * "↑ N more above" / "↓ N more below" hints around the visible window so
 * users can see at a glance that the list overflows. Closes #100 — the
 * obsidian-mind v6 install silently truncated the optional-modules list
 * at the default 5-row viewport.
 */
export default function ScrollableMultiSelect({
  options,
  defaultValue,
  visibleOptionCount = 5,
  onChange,
  onSubmit,
  isDisabled = false,
}: ScrollableMultiSelectProps) {
  // Defensive clamp so a misconfigured caller (terminal-rows math gone
  // wrong, accidentally `0`, etc.) can't render an invisible viewport
  // that still mutates state on keystrokes.
  const visibleCount = Math.max(1, visibleOptionCount);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>(() => [...new Set(defaultValue ?? [])]);
  // What the key handler reads and writes. Ink runs every key of one input
  // chunk (a paste, a key repeat, a terminal that coalesces keystrokes)
  // before React re-renders, so state read from the render closure would be
  // the state from before the chunk: an arrow then a space would toggle the
  // row the cursor left (#317). Each key updates these first, then the
  // render state.
  const focusRef = useRef(focusedIndex);
  const offsetRef = useRef(scrollOffset);
  const selectedRef = useRef(selected);

  const handleKey = (input: string, key: Key): void => {
      // A run of plain keys (spaces, Enter) arrives as one input, and an
      // Enter in it is not reported as `key.return` (#317): one at a time.
      if (input.length > 1) {
        // A CR LF is one Enter; a walked key is never an arrow.
        for (const ch of input.replace(/\r\n/g, '\r')) {
          handleKey(ch, { ...key, upArrow: false, downArrow: false, return: ch === '\r' || ch === '\n' });
        }
        return;
      }
      if (options.length === 0) {
        if (key.return) onSubmit?.(selectedRef.current);
        return;
      }
      // Re-clamp the focus against the current options length. A parent
      // rerender that shrinks `options` can leave the stored index past the
      // end; without this, SPACE would read `options[stale]` (undefined) and
      // silently no-op even though the rendered focus marker (which uses
      // the same clamp at render time) pointed at a valid row.
      const cur = Math.min(Math.max(0, focusRef.current), options.length - 1);
      const focus = (index: number, offset: number) => {
        focusRef.current = index;
        offsetRef.current = offset;
        setFocusedIndex(index);
        setScrollOffset(offset);
      };

      if (key.downArrow) {
        const next = Math.min(cur + 1, options.length - 1);
        if (next === cur) return;
        focus(next, next >= offsetRef.current + visibleCount ? next - visibleCount + 1 : offsetRef.current);
        return;
      }
      if (key.upArrow) {
        const prev = Math.max(cur - 1, 0);
        if (prev === cur) return;
        focus(prev, prev < offsetRef.current ? prev : offsetRef.current);
        return;
      }
      if (input === ' ') {
        const focused = options[cur];
        if (!focused) return;
        const now = selectedRef.current;
        const next = now.includes(focused.value)
          ? now.filter((v) => v !== focused.value)
          : [...now, focused.value];
        selectedRef.current = next;
        setSelected(next);
        onChange?.(next);
        return;
      }
      if (key.return) {
        onSubmit?.(selectedRef.current);
      }
  };
  useInput(handleKey, { isActive: !isDisabled });

  // Re-clamp at render so an external `options` shrink between renders
  // can't desync stored state from what the user sees.
  const clampedFocus = options.length === 0
    ? 0
    : Math.min(Math.max(0, focusedIndex), options.length - 1);
  const clampedOffset = clampScrollOffset(
    scrollOffset,
    clampedFocus,
    options.length,
    visibleCount,
  );
  const visibleStart = clampedOffset;
  const visibleEnd = Math.min(options.length, clampedOffset + visibleCount);
  const visible = options.slice(visibleStart, visibleEnd);
  const selectedSet = new Set(selected);
  const aboveCount = visibleStart;
  const belowCount = Math.max(0, options.length - visibleEnd);

  return (
    <Box flexDirection="column">
      {aboveCount > 0 && <Text dimColor>↑ {aboveCount} more above</Text>}
      {visible.map((opt, i) => {
        const optIndex = i + visibleStart;
        const isFocused = optIndex === clampedFocus && !isDisabled;
        const isSelected = selectedSet.has(opt.value);
        const cursor = isFocused ? '❯ ' : '  ';
        const checkbox = isSelected ? '◆ ' : '◇ ';
        return (
          <Text key={opt.value} color={isFocused ? 'blue' : undefined}>
            {cursor}
            {checkbox}
            {opt.label}
          </Text>
        );
      })}
      {belowCount > 0 && <Text dimColor>↓ {belowCount} more below</Text>}
    </Box>
  );
}

/**
 * Pure scroll-offset clamp. Pushes focused into the visible window from
 * whichever edge it's outside, then clamps to [0, max(0, total - visible)].
 * Exposed so property tests can pin the invariants without rendering.
 */
export function clampScrollOffset(
  scrollOffset: number,
  focusedIndex: number,
  total: number,
  visible: number,
): number {
  if (total <= 0 || visible <= 0) return 0;
  if (total <= visible) return 0;
  const maxOffset = total - visible;
  let next = scrollOffset;
  if (focusedIndex < next) next = focusedIndex;
  if (focusedIndex >= next + visible) next = focusedIndex - visible + 1;
  if (next < 0) next = 0;
  if (next > maxOffset) next = maxOffset;
  return next;
}
