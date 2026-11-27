type ChartPoint = {
  label: string
  value: number
}


export default function CompanyStatisticsChart({
  title, points, detail, statusMessage, unavailable,
}: {
  title: string
  points?: ChartPoint[]
  detail?: string
  statusMessage?: string
  unavailable?: boolean
}) {
  const width = 760
  const height = 250
  const paddingLeft = 42
  const paddingRight = 22
  const paddingTop = 22
  const paddingBottom = 42
  const plotWidth = width - paddingLeft - paddingRight
  const plotHeight = height - paddingTop - paddingBottom
  const values = points ?? []
  const peak = Math.max(1, ...values.map((point) => point.value))
  const tickStep = Math.ceil(peak / 4)
  const tickCount = Math.ceil(peak / tickStep)
  const maximum = tickCount * tickStep
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (tickCount - index) * tickStep)
  const yForValue = (value: number) => paddingTop + plotHeight - (value / maximum) * plotHeight
  const coordinates = values.map((point, index) => ({
    ...point,
    x:
      paddingLeft +
      (values.length === 1
        ? plotWidth / 2
        : (index / (values.length - 1)) * plotWidth),
    y: yForValue(point.value),
  }))
  const linePath = coordinates
    .map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    )
    .join(' ')
  const areaPath = `${linePath} L ${
    coordinates[coordinates.length - 1]?.x ?? paddingLeft
  } ${paddingTop + plotHeight} L ${
    coordinates[0]?.x ?? paddingLeft
  } ${paddingTop + plotHeight} Z`
  const total = values.reduce((sum, point) => sum + point.value, 0)

  return (
    <section className="dashboardCompanyChart">
      <div className="dashboardCompanyChartHeader">
        <div>
          <p className="dashboardEyebrow">COMPANY STATISTICS</p>
          <h2>{title}</h2>
          <p>{detail ?? 'Daily activity over the last seven days.'}</p>
        </div>

        <div className="dashboardCompanyChartTotal">
          <span>7-day total</span>
          <strong>{points ? total : '—'}</strong>
        </div>
      </div>

      {statusMessage && <p className="dashboardCompanyChartMessage" role={unavailable ? 'alert' : 'status'}>{statusMessage}</p>}
      {points && <div className="dashboardCompanyChartCanvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title} line graph for the last seven days`}
        >
          <defs>
            <linearGradient
              id="dashboardChartArea"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#00e676" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#00e676" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((value) => {
            const y = yForValue(value)

            return (
              <g key={value}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="rgba(255,255,255,0.09)"
                  strokeWidth="1"
                />
                <text
                  x={paddingLeft - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="rgba(235,244,238,0.45)"
                  fontSize="11"
                >
                  {value}
                </text>
              </g>
            )
          })}

          <path d={areaPath} fill="url(#dashboardChartArea)" />
          <path
            d={linePath}
            fill="none"
            stroke="#00e676"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {coordinates.map((point) => (
            <g key={point.label}>
              <circle
                cx={point.x}
                cy={point.y}
                r="5"
                fill="#07140d"
                stroke="#00e676"
                strokeWidth="3"
              >
                <title>{point.label} · {point.value}</title>
              </circle>
              <text
                x={point.x}
                y={height - 15}
                textAnchor="middle"
                fill="rgba(235,244,238,0.58)"
                fontSize="11"
              >
                {point.label}
              </text>
            </g>
          ))}
        </svg>
      </div>}
    </section>
  )
}
