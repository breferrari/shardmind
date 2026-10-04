/*!
 * ui-kit: Select, TextInput, Alert, Badge, ProgressBar, Spinner and
 * StatusMessage, vendored from @inkjs/ui 2.0.0
 * (github.com/vadimdemedes/ink-ui, tag v2.0.0, commit
 * 14b1145da0123a48cfc2f0ec9ff33dff0633f464), with ShardMind's fixes as
 * separate commits on top. MIT; the licence is in ./LICENSE and
 * provenance in ./PROVENANCE.md.
 *
 * Copyright (c) 2026 Brenno Ferrari (this file and ShardMind's
 * modifications). MIT.
 *
 * The only public entry point. The module imports only ink, react,
 * node: built-ins and its own files (tests/ui-kit/boundary.test.ts), so
 * it can move to its own package with a `git mv` and a package.json.
 */

export {Alert, type AlertProps} from './components/alert/index.js';
export {Badge, type BadgeProps} from './components/badge/index.js';
export {ProgressBar, type ProgressBarProps} from './components/progress-bar/index.js';
export {Select, type SelectProps} from './components/select/index.js';
export {Spinner, type SpinnerProps} from './components/spinner/index.js';
export {StatusMessage, type StatusMessageProps} from './components/status-message/index.js';
export {TextInput, type TextInputProps} from './components/text-input/index.js';
export {type Option} from './types.js';
export {type SpinnerName} from './lib/spinners.js';
export {ThemeProvider, defaultTheme, type Theme, type ComponentTheme} from './theme.js';
