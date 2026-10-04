/**
 * Single indirection layer over the TUI primitives. All TUI code imports
 * components from here so that swapping a backend is a one-file change.
 *
 * Every component comes from the vendored ui-kit (#43, #273; see
 * docs/ARCHITECTURE.md §11.4).
 */
export {
  Alert,
  Badge,
  ProgressBar,
  Select,
  Spinner,
  StatusMessage,
  TextInput,
} from '../ui-kit/index.js';
