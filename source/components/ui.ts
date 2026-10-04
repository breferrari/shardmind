/**
 * Single indirection layer over the TUI primitives. All TUI code imports
 * components from here so that swapping a backend is a one-file change.
 *
 * `Select` and `TextInput` come from the vendored ui-kit (#43, see
 * docs/ARCHITECTURE.md §11.4); the rest from @inkjs/ui.
 */
export { Select, TextInput } from '../ui-kit/index.js';
export { Alert, Badge, ProgressBar, Spinner, StatusMessage } from '@inkjs/ui';
