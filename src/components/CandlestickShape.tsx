import React from 'react';

export const CandlestickShape = (props: any) => {
  const { x, y, width, height, payload, yAxis } = props;
  
  if (!yAxis || !payload || payload.open === undefined || payload.close === undefined || payload.high === undefined || payload.low === undefined) {
    return null;
  }

  const { open, close, high, low } = payload;
  const isUp = close >= open;
  const color = isUp ? '#10b981' : '#ef4444'; // Emerald for up, Red for down

  // Calculate pixel coordinates
  const yOpen = yAxis.scale(open);
  const yClose = yAxis.scale(close);
  const yHigh = yAxis.scale(high);
  const yLow = yAxis.scale(low);

  const rectY = Math.min(yOpen, yClose);
  const rectHeight = Math.abs(yOpen - yClose) || 1; // Ensure at least 1px height
  
  const centerX = x + width / 2;

  return (
    <g stroke={color} fill={color} strokeWidth={1}>
      {/* High-Low line (wick) */}
      <line x1={centerX} y1={yHigh} x2={centerX} y2={yLow} />
      {/* Open-Close body */}
      <rect x={x} y={rectY} width={width} height={rectHeight} />
    </g>
  );
};
