/**
 * Single indirection layer over @inkjs/ui. All TUI code imports
 * components from here rather than directly from @inkjs/ui so that
 * swapping the backend (vendoring, forking, migrating to another
 * library) is a one-file change.
 */
export {
  Alert,
  Badge,
  ConfirmInput,
  MultiSelect,
  ProgressBar,
  Select,
  Spinner,
  StatusMessage,
  TextInput,
} from '@inkjs/ui';
