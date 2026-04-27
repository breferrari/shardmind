import { Box, Text } from 'ink';

/**
 * Two-line "newer shardmind on npm" banner — one line for the version
 * announcement, one for the actionable install command. Renders nothing
 * when `info` is `null` (suppressed via flag / env / non-TTY / cache
 * miss / fetch failure / current === latest) so callers can render it
 * unconditionally above their main UI without conditional wrapping.
 *
 * The data is delivered via the `useSelfUpdateCheck` hook, which fires
 * the npm-registry check after first paint — so the first frame never
 * carries the banner. Subsequent frames pick it up once the (cached or
 * live) result resolves.
 *
 * See ROADMAP §0.1.x Foundation #113 + docs/IMPLEMENTATION.md §4.19.
 */
interface SelfUpdateBannerProps {
  info: { current: string; latest: string } | null;
}

export default function SelfUpdateBanner({ info }: SelfUpdateBannerProps) {
  if (!info) return null;
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
    >
      <Text>
        shardmind <Text bold>{info.latest}</Text> available{' '}
        <Text dimColor>(you have {info.current})</Text>
      </Text>
      <Text dimColor>
        Run: <Text>npm install -g shardmind@latest</Text>
      </Text>
    </Box>
  );
}
