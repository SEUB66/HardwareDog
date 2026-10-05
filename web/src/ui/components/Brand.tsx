import head1x from '../../../../assets/brand/web/hd-head-1x.webp';
import head2x from '../../../../assets/brand/web/hd-head-2x.webp';
import head3x from '../../../../assets/brand/web/hd-head-3x.webp';

/** The official head and the name, as one lockup. */
export function Brand({ size = 44 }: { size?: number }) {
  return (
    <span class="brand-lockup" style={{ fontSize: `${Math.round(size * 0.5)}px` }}>
      <img src={head1x} srcset={`${head1x} 1x, ${head2x} 2x, ${head3x} 3x`} width={size} height={size} alt="" />
      <span class="wordmark">
        HARDWARE <b>DOG</b>
      </span>
    </span>
  );
}
