/*
 * From pastel@4.0.1 (https://github.com/vadimdemedes/pastel at fe4ce10046a55d0492a35b1ae08f54b5c64775e4), _app.tsx.
 * Copyright (c) Vadym Demedes. MIT: see cli-kit/LICENSE.
 */

import type {AppProps} from './types.js';

export default function App({Component, commandProps}: AppProps) {
	return <Component {...commandProps} />;
}
