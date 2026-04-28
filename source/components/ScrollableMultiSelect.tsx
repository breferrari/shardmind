import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

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

  useInput(
    (input, key) => {
      if (options.length === 0) {
        if (key.return) onSubmit?.(selected);
        return;
      }
      if (key.downArrow) {
        const next = Math.min(focusedIndex + 1, options.length - 1);
        if (next === focusedIndex) return;
        setFocusedIndex(next);
        if (next >= scrollOffset + visibleCount) {
          setScrollOffset(next - visibleCount + 1);
        }
        return;
      }
      if (key.upArrow) {
        const prev = Math.max(focusedIndex - 1, 0);
        if (prev === focusedIndex) return;
        setFocusedIndex(prev);
        if (prev < scrollOffset) {
          setScrollOffset(prev);
        }
        return;
      }
      if (input === ' ') {
        const focused = options[focusedIndex];
        if (!focused) return;
        const has = selected.includes(focused.value);
        const next = has
          ? selected.filter((v) => v !== focused.value)
          : [...selected, focused.value];
        setSelected(next);
        onChange?.(next);
        return;
      }
      if (key.return) {
        onSubmit?.(selected);
      }
    },
    { isActive: !isDisabled },
  );

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
