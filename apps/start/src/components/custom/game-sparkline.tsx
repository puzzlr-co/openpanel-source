/**
 * Sparkline for a single game row in the Games widget (fork-only).
 *
 * Intentionally not the app's visx chart stack: this is one series with no axes
 * and no legend — the row label names it — so the stack's tooltip/axis/scale
 * machinery would be pure overhead at ~13 instances per page.
 *
 * The values are always shown as numbers in the same row, so the line never
 * carries information on its own. That matters here: the app's categorical chart
 * palette sits below 3:1 contrast against the surface, which is legible for a
 * mark beside a label but not as a sole encoding.
 */
type GameSparklineProps = {
  values: number[];
  /** Shared across rows so panel heights are comparable, not per-row scaled. */
  domainMax: number;
  /** chartColors[n].main — the stroke. */
  color: string;
  /** chartColors[n].translucent — the palette's own fill for that stroke. */
  fill: string;
  /** Screen-reader description; the drawing itself is decorative. */
  label: string;
  width?: number;
  height?: number;
};

export function GameSparkline({
  values,
  domainMax,
  color,
  fill,
  label,
  width = 120,
  height = 28,
}: GameSparklineProps) {
  // A single point has no shape to draw, and a zero domain would divide by zero.
  if (values.length < 2 || domainMax <= 0) {
    return <div aria-hidden="true" style={{ width, height }} />;
  }

  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    // Baseline pinned at zero: a truncated baseline exaggerates day-to-day
    // movement, which is the opposite of what a comparison table needs.
    const ratio = Math.min(1, Math.max(0, v / domainMax));
    // Inset by the stroke half-width so the line never clips at the edges.
    return [i * stepX, height - 1 - ratio * (height - 2)] as const;
  });

  const line = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');

  return (
    <svg
      aria-label={label}
      className="overflow-visible"
      focusable="false"
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <path
        d={`${line} L${width},${height} L0,${height} Z`}
        fill={fill}
        stroke="none"
      />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}
