import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Bar, Cell, ReferenceArea, ReferenceLine, Customized
} from 'recharts';
import {
  Activity, Settings, ChevronDown, Plus, Play, ShieldAlert,
  TrendingUp, Clock, BarChart2, AlertCircle, Star, Search, X,
  Bell, BellOff, Trash2, LayoutGrid, ChevronUp
} from 'lucide-react';
import { useKlines } from './hooks/useKlines';
import { calculateSMA, calculateRSI, calculateMACD, calculateBollingerBands } from './lib/indicators';
import { runStrategy, StrategyResult } from './lib/strategy';
import { formatPrice, formatPriceString, getDecimals } from './lib/utils';
import { useFundingRate } from './hooks/useFundingRate';
import BacktestPanel from './components/BacktestPanel';
import { useAlerts } from './hooks/useAlerts';
import { useMultiTimeframe } from './hooks/useMultiTimeframe';
import { detectHarmonics, HarmonicPattern } from './lib/harmonics';
import { detectSNRFVG, SNRFVGResult } from './lib/snrFvg';

// ─── 圖表參數 Preset（由 BacktestPanel 的「載入至圖表」寫入）───
const CHART_PRESET_KEY = 'qv_chart_preset';
interface ChartPreset {
  name: string; strategyId: string;
  snrLqP: { snrStrength: number; fvgMinSizePct: number; volumeThreshold: number; signalGap: number };
}
function readChartPreset(): ChartPreset | null {
  try { return JSON.parse(localStorage.getItem(CHART_PRESET_KEY) || 'null'); } catch { return null; }
}


// ── PriceText component ──
const PriceText = ({ price, className = '' }: { price: number; className?: string }) => {
  const f = formatPrice(price);
  if (f.type === 'subscript') {
    return (
      <span className={className}>
        0.0<sub style={{ fontSize: '0.65em', lineHeight: 0, verticalAlign: 'sub' }}>{f.zeros - 1}</sub>{f.sig}
      </span>
    );
  }
  return <span className={className}>{f.value}</span>;
};

// ── Candlestick Shape ──
const CandlestickShape = (props: any) => {
  const { x, y, width, height, payload } = props;
  if (!payload || payload.open === undefined) return null;
  const { open, close, high, low } = payload;
  const isUp = close >= open;
  const color = isUp ? '#089981' : '#F23645';
  const range = high - low;
  if (range === 0) return <line x1={x} y1={y} x2={x + width} y2={y} stroke={color} strokeWidth={1.5} />;
  const pxPerVal = height / range;
  const yOpen  = y + (high - open)  * pxPerVal;
  const yClose = y + (high - close) * pxPerVal;
  const rectY  = Math.min(yOpen, yClose);
  const rectH  = Math.max(Math.abs(yOpen - yClose), 1);
  const cx = x + width / 2;
  return (
    <g stroke={color} fill={color} strokeWidth={1.5}>
      <line x1={cx} y1={y} x2={cx} y2={y + height} />
      <rect x={x} y={rectY} width={width} height={rectH} />
    </g>
  );
};

// ── Constants ──
const SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOGEUSDT',
  'XRPUSDT','DOTUSDT','LINKUSDT','AVAXUSDT','LTCUSDT','UNIUSDT',
  'ATOMUSDT','ETCUSDT','XLMUSDT','ALGOUSDT','FILUSDT','NEARUSDT',
  'VETUSDT','ICPUSDT','TRXUSDT','AAVEUSDT','EOSUSDT','FTMUSDT',
  'PEPEUSDT','SHIBUSDT','BONKUSDT','WIFUSDT','FLOKIUSDT',
];

const INTERVALS = [
  { label: '5m',  value: '5m'  },
  { label: '15m', value: '15m' },
  { label: '1H',  value: '1h'  },
  { label: '4H',  value: '4h'  },
  { label: '1D',  value: '1d'  },
];

const STRATEGIES = [
  { id: 'ms_ob',               name: 'Market Structure + OB'  },
  { id: 'structural_reversal', name: 'Structural Reversal (PRZ)' },
  { id: 'smc_session',         name: 'SMC Rolling Session'    },
  { id: 'snr_fvg',             name: 'SNR + FVG 獵取'         },
  { id: 'harmonics',           name: '諧波形態'               },
];

// Mobile tabs
type MobileTab = 'chart' | 'signal' | 'alerts' | 'backtest';

// ── Volume spike detection ──
function detectVolumeSpikes(data: any[]): Set<number> {
  if (data.length < 20) return new Set();
  const spikes = new Set<number>();
  for (let i = 20; i < data.length; i++) {
    const slice = data.slice(i - 20, i);
    const avg = slice.reduce((s, d) => s + (d.volume || 0), 0) / 20;
    if ((data[i].volume || 0) > avg * 2.5) spikes.add(i);
  }
  return spikes;
}

// ── Support/Resistance detection ──
function detectSupportResistance(data: any[], n = 5): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];
  for (let i = n; i < data.length - n; i++) {
    const window = data.slice(i - n, i + n + 1);
    const maxH = Math.max(...window.map((d: any) => d.high));
    const minL = Math.min(...window.map((d: any) => d.low));
    if (data[i].high === maxH) resistance.push(data[i].high);
    if (data[i].low  === minL) support.push(data[i].low);
  }
  // Cluster nearby levels
  const cluster = (arr: number[], threshold: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const result: number[] = [];
    let group: number[] = [];
    for (const v of sorted) {
      if (group.length === 0 || v - group[group.length - 1] < threshold) {
        group.push(v);
      } else {
        result.push(group.reduce((a, b) => a + b) / group.length);
        group = [v];
      }
    }
    if (group.length) result.push(group.reduce((a, b) => a + b) / group.length);
    return result.slice(-3); // top 3
  };
  const price = data[data.length - 1]?.close || 1;
  const threshold = price * 0.005;
  return {
    support: cluster(support, threshold),
    resistance: cluster(resistance, threshold),
  };
}

export default function App() {
  // ── Persisted state ──
  const [symbol, setSymbol]     = useState(() => { try { return localStorage.getItem('qv_symbol') || 'BTCUSDT'; } catch { return 'BTCUSDT'; } });
  const [interval, setInterval] = useState(() => { try { return localStorage.getItem('qv_interval') || '15m'; } catch { return '15m'; } });

  const [strategyId, setStrategyId]   = useState('ms_ob');
  const [chartType, setChartType]     = useState<'candles' | 'line'>('candles');
  const [showRSI,  setShowRSI]        = useState(false);
  const [showSMA,  setShowSMA]        = useState(true);
  const [showMACD, setShowMACD]       = useState(false);
  const [showBB,   setShowBB]         = useState(false);
  const [showSR,   setShowSR]         = useState(false);
  const [showVolSpike, setShowVolSpike] = useState(false);
  const [strategyResult, setStrategyResult]       = useState<StrategyResult | null>(null);
  const [isStrategyRunning, setIsStrategyRunning] = useState(false);
  const [harmonicPatterns, setHarmonicPatterns]   = useState<HarmonicPattern[]>([]);
  const [snrFvgResult, setSnrFvgResult]         = useState<SNRFVGResult | null>(null);
  const [chartPreset, setChartPreset]           = useState<ChartPreset | null>(() => readChartPreset());

  // 監聽 BacktestPanel 的「載入至圖表」
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'qv_chart_preset') {
        setChartPreset(readChartPreset());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const harmonicPattern = harmonicPatterns[0] ?? null;
  const [mobileTab, setMobileTab]     = useState<MobileTab>('chart');

  // 諧波掃描器
  const [scanResults, setScanResults]   = useState<{ symbol: string; pattern: HarmonicPattern }[]>([]);
  const [isScanning, setIsScanning]     = useState(false);
  const [showScanner, setShowScanner]   = useState(false);
  const [scanSymbols, setScanSymbols]   = useState<string[]>([]);
  const [showAlertPanel, setShowAlertPanel] = useState(false);

  // Search
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery,  setSearchQuery]  = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('favoriteSymbols') || '["BTCUSDT","ETHUSDT","SOLUSDT"]'); }
    catch { return ['BTCUSDT','ETHUSDT','SOLUSDT']; }
  });
  const [availableSymbols, setAvailableSymbols] = useState<string[]>(SYMBOLS);
  const [customSymbols, setCustomSymbols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('customSymbols') || '[]'); } catch { return []; }
  });
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

  // Persist symbol + interval
  useEffect(() => { try { localStorage.setItem('qv_symbol', symbol); } catch {} }, [symbol]);
  useEffect(() => { try { localStorage.setItem('qv_interval', interval); } catch {} }, [interval]);
  useEffect(() => { try { localStorage.setItem('favoriteSymbols', JSON.stringify(favorites)); } catch {} }, [favorites]);
  useEffect(() => { try { localStorage.setItem('customSymbols', JSON.stringify(customSymbols)); } catch {} }, [customSymbols]);

  // Fetch all Binance USDT pairs
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('https://data-api.binance.vision/api/v3/ticker/price');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            const syms = data.filter((s: any) => s.symbol?.endsWith('USDT')).map((s: any) => s.symbol);
            if (syms.length > 0) setAvailableSymbols(Array.from(new Set([...SYMBOLS, ...syms])));
          }
        }
      } catch (_) {}
    })();
  }, []);

  // Click outside search — 用 mousedown 但要排除 dropdown 內的點擊
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inDesktop = searchRef.current?.contains(target);
      const inMobile  = mobileSearchRef.current?.contains(target);
      // 也排除 fixed position 的 dropdown（portal 出去了）
      const inDropdown = (target as Element)?.closest?.('[data-search-dropdown]');
      if (!inDesktop && !inMobile && !inDropdown) {
        setIsSearchOpen(false); setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allSymbols = useMemo(() => Array.from(new Set([...availableSymbols, ...customSymbols])), [availableSymbols, customSymbols]);

  const filteredSymbols = useMemo(() => {
    const q = searchQuery.toUpperCase().trim();
    const list = q ? allSymbols.filter(s => s.includes(q)) : allSymbols;
    return list.sort((a, b) => {
      if (q) {
        if ((a === q || a === `${q}USDT`) && !(b === q || b === `${q}USDT`)) return -1;
        if (!(a === q || a === `${q}USDT`) && (b === q || b === `${q}USDT`)) return 1;
        if (a.startsWith(q) && !b.startsWith(q)) return -1;
        if (!a.startsWith(q) && b.startsWith(q)) return 1;
      }
      const af = favorites.includes(a), bf = favorites.includes(b);
      if (af && !bf) return -1; if (!af && bf) return 1;
      return a.localeCompare(b);
    }).slice(0, 100);
  }, [searchQuery, favorites, allSymbols]);

  const toggleFavorite = (e: React.MouseEvent, sym: string) => {
    e.stopPropagation();
    setFavorites(p => p.includes(sym) ? p.filter(s => s !== sym) : [...p, sym]);
  };

  const handleAddCustomSymbol = () => {
    let s = searchQuery.toUpperCase().trim();
    if (!s) return;
    if (!s.endsWith('USDT') && !allSymbols.includes(s)) s += 'USDT';
    if (!allSymbols.includes(s)) setCustomSymbols(p => [...p, s]);
    setSymbol(s); setIsSearchOpen(false); setSearchQuery('');
  };

  const selectSymbol = (s: string, jumpToChart = false) => {
    setSymbol(s); setIsSearchOpen(false); setSearchQuery(''); setStrategyResult(null);
    if (jumpToChart) setMobileTab('chart');
  };

  // Klines
  useEffect(() => { setStrategyResult(null); }, [symbol, interval]);
  const { data: rawData, loading, error, isFutures } = useKlines(symbol, interval, 150);

  const chartData = useMemo(() => {
    if (!rawData || rawData.length === 0) return [];
    const closes = rawData.map(d => d.close);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const rsi14 = calculateRSI(closes, 14);
    const { macdLine, signalLine, histogram } = calculateMACD(closes);
    const { upper: bbUpper, lower: bbLower, middle: bbMiddle } = calculateBollingerBands(closes, 20, 2);
    return rawData.map((d, i) => ({
      ...d,
      timeStr: new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }),
      sma20: sma20[i], sma50: sma50[i],
      rsi: rsi14[i],
      macd: macdLine[i], macdSignal: signalLine[i], macdHist: histogram[i],
      bbUpper: bbUpper[i], bbLower: bbLower[i], bbMiddle: bbMiddle[i],
      range: [d.low, d.high],
      closePrice: d.close,
    }));
  }, [rawData]);

  // XABCD 折線資料：把諧波點注入 chartData
  const harmonicChartData = useMemo(() => {
    if (!harmonicPatterns.length || !chartData.length) return chartData;
    const hp = harmonicPatterns[0];
    const pts: { index: number; price: number; label: string }[] = [
      { ...hp.X, label: 'X' }, { ...hp.A, label: 'A' },
      { ...hp.B, label: 'B' }, { ...hp.C, label: 'C' },
      { ...hp.D, label: 'D' },
    ].sort((a, b) => a.index - b.index);
    // 建立 index→price 的 map，中間點用線性插值
    const pointMap = new Map(pts.map(p => [p.index, p.price]));
    // 找出相鄰兩點間要連線的區間
    const segments: [number, number][] = [];
    const sorted = pts.map(p => p.index);
    for (let i = 0; i < sorted.length - 1; i++) segments.push([sorted[i], sorted[i+1]]);
    return chartData.map((d, i) => {
      let hpLine: number | undefined = undefined;
      if (pointMap.has(i)) {
        hpLine = pointMap.get(i);
      } else {
        for (const [s, e] of segments) {
          if (i > s && i < e) {
            const p1 = pointMap.get(s)!;
            const p2 = pointMap.get(e)!;
            hpLine = p1 + (p2 - p1) * ((i - s) / (e - s));
            break;
          }
        }
      }
      return { ...d, hpLine };
    });
  }, [chartData, harmonicPatterns]);

  const volumeSpikes = useMemo(() => detectVolumeSpikes(chartData), [chartData]);
  const srLevels = useMemo(() => detectSupportResistance(chartData), [chartData]);

  const currentPrice = chartData.length > 0 ? chartData[chartData.length - 1].close : 0;
  const priceChange  = chartData.length > 1 ? currentPrice - chartData[chartData.length - 2].close : 0;
  const priceChangePct = chartData.length > 1 ? (priceChange / chartData[chartData.length - 2].close) * 100 : 0;
  const decimals = getDecimals(currentPrice);

  const yDomain = useMemo(() => {
    if (!chartData.length) return ['auto', 'auto'];
    let min = Math.min(...chartData.map(d => d.low));
    let max = Math.max(...chartData.map(d => d.high));
    if (strategyResult) {
      const vals = [strategyResult.target, strategyResult.stop, strategyResult.entry_low, strategyResult.entry_high,
        strategyResult.smcDetails?.targetHigh, strategyResult.smcDetails?.targetLow].filter(v => typeof v === 'number' && v > 0) as number[];
      if (vals.length) { min = Math.min(min, ...vals); max = Math.max(max, ...vals); }
    }
    if (showSR) {
      const srVals = [...srLevels.support, ...srLevels.resistance].filter(v => v > 0);
      if (srVals.length) { min = Math.min(min, ...srVals); max = Math.max(max, ...srVals); }
    }
    if (isNaN(min) || isNaN(max)) return ['auto', 'auto'];
    const pad = (max - min) * 0.05;
    return [min - (pad || max * 0.01), max + (pad || max * 0.01)];
  }, [chartData, strategyResult, srLevels, showSR]);

  // Hooks
  const fundingData   = useFundingRate(symbol, isFutures);
  const { alerts, addAlert, removeAlert, clearTriggered, notifPermission, requestPermission } = useAlerts(currentPrice, symbol);
  const { signals: mtfSignals, loading: mtfLoading } = useMultiTimeframe(symbol);

  const handleRunStrategy = async () => {
    setIsStrategyRunning(true);
    setHarmonicPatterns([]);
    try {
      if (strategyId === 'harmonics') {
        const rsiValues = chartData.map(d => d.rsi).filter((v): v is number => typeof v === 'number');
        const patterns = detectHarmonics(
          chartData.map(d => ({ open: d.open, high: d.high, low: d.low, close: d.close })),
          rsiValues.length === chartData.length ? rsiValues : undefined
        );
        // 用 MTF 背離結果覆蓋形態的 rsiBull/rsiBear，保持一致性
        const mtfDivBull = mtfSignals.some(s => s.divergence === 'CONFIRMED_BULL' || s.divergence === 'WARNING_BULL');
        const mtfDivBear = mtfSignals.some(s => s.divergence === 'CONFIRMED_BEAR' || s.divergence === 'WARNING_BEAR');
        const mtfDivConfirmed = mtfSignals.some(s => s.divergence?.startsWith('CONFIRMED'));
        const patchedPatterns = patterns.map(hp => {
          const rsiBull = hp.direction === 'LONG'  && mtfDivBull;
          const rsiBear = hp.direction === 'SHORT' && mtfDivBear;
          // 重算 score
          let score = hp.quality * 0.30;
          if (hp.status === 'ACTIVE')      score += 15;
          if (hp.status === 'PRZ_TOUCHED') score += 25;
          if (hp.status === 'CONFIRMED')   score += 30;
          if (rsiBull || rsiBear) score += mtfDivConfirmed ? 25 : 12;
          if (hp.reversalCandle)  score += 15;
          return { ...hp, rsiBull, rsiBear, score: Math.min(Math.round(score), 100) };
        }).sort((a, b) => b.score - a.score);
        setHarmonicPatterns(patchedPatterns);
        setStrategyResult(null);
      } else if (strategyId === 'snr_fvg') {
        const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=15m&limit=200`);
        if (res.ok) {
          const raw = await res.json();
          const klines = raw.map((k: any) => ({
            open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
          const snrP = chartPreset?.snrLqP;
          const result = detectSNRFVG(
            klines,
            snrP?.snrStrength ?? 15,
            snrP?.fvgMinSizePct ?? 0.05,
            snrP?.volumeThreshold ?? 1.1,
            snrP?.signalGap ?? 3,
          );
          setSnrFvgResult(result);
        }
        setStrategyResult(null);
      } else {
        const result = await runStrategy(symbol, strategyId);
        setStrategyResult(result);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsStrategyRunning(false);
    }
  };

  // 選了策略或換幣種自動跑
  useEffect(() => {
    if (strategyId) handleRunStrategy();
  }, [strategyId, symbol]);

  // ── 諧波掃描器邏輯 ──
  const handleScan = async (symbols: string[]) => {
    if (isScanning || symbols.length === 0) return;
    setIsScanning(true);
    setScanResults([]);
    const results: { symbol: string; pattern: HarmonicPattern }[] = [];
    for (const sym of symbols) {
      try {
        const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=15m&limit=150`);
        if (!res.ok) continue;
        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length < 50) continue;
        const klines = raw.map((k: any) => ({
          open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]),
        }));
        const closes = klines.map(k => k.close);
        const rsiArr = calculateRSI(closes, 14);
        const patterns = detectHarmonics(klines, rsiArr.length === klines.length ? rsiArr : undefined);
        if (patterns.length > 0) {
          // 掃描也用多時框架背離加分（同時拿 1H K 線做簡易背離判斷）
          const res1h = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=50`).catch(() => null);
          let divConfirmed = false;
          if (res1h?.ok) {
            const raw1h = await res1h.json().catch(() => []);
            if (Array.isArray(raw1h) && raw1h.length >= 20) {
              const closes1h = raw1h.map((k: any) => parseFloat(k[4]));
              const rsi1h = calculateRSI(closes1h, 14);
              const lastRsi = rsi1h[rsi1h.length - 1];
              const prevRsi = rsi1h[rsi1h.length - 6];
              const lastPrice = closes1h[closes1h.length - 1];
              const prevPrice = closes1h[closes1h.length - 6];
              divConfirmed = (lastPrice < prevPrice && lastRsi > prevRsi) ||
                             (lastPrice > prevPrice && lastRsi < prevRsi);
            }
          }
          const top = patterns[0];
          const rsiBull = top.direction === 'LONG' && divConfirmed;
          const rsiBear = top.direction === 'SHORT' && divConfirmed;
          let score = top.quality * 0.30;
          if (top.status === 'ACTIVE')      score += 15;
          if (top.status === 'PRZ_TOUCHED') score += 25;
          if (top.status === 'CONFIRMED')   score += 30;
          if (rsiBull || rsiBear) score += divConfirmed ? 25 : 12;
          if (top.reversalCandle) score += 15;
          results.push({ symbol: sym, pattern: { ...top, rsiBull, rsiBear, score: Math.min(Math.round(score), 100) } });
        }
      } catch {}
    }
    results.sort((a, b) => b.pattern.score - a.pattern.score);
    setScanResults(results);
    setIsScanning(false);
  };

  // ── Search dropdown (shared) ──
  const SearchDropdown = ({ inputRef }: { inputRef: React.RefObject<HTMLInputElement> }) => {
    const rect = inputRef.current?.getBoundingClientRect();
    const style: React.CSSProperties = rect ? {
      position: 'fixed',
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      width: 288,
      zIndex: 99999,
    } : {};
    return (
    <div style={style} data-search-dropdown="true" className="bg-[#1E222D] border border-[#2A2E39] rounded-xl shadow-2xl overflow-hidden">
      <div className="max-h-72 overflow-y-auto custom-scrollbar">
        {filteredSymbols.length > 0 ? filteredSymbols.map(s => {
          const isFav = favorites.includes(s);
          return (
            <button key={s} onClick={() => selectSymbol(s)}
              className={`w-full flex items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ${symbol === s ? 'bg-[#2962FF]/10 text-[#2962FF] font-medium' : 'text-[#D1D4DC] hover:bg-[#2A2E39]'}`}>
              {s}
              <Star onClick={(e) => toggleFavorite(e, s)}
                className={`w-4 h-4 shrink-0 transition-colors ${isFav ? 'fill-[#FFC107] text-[#FFC107]' : 'text-[#787B86] hover:text-[#D1D4DC]'}`} />
            </button>
          );
        }) : <div className="px-4 py-3 text-sm text-[#787B86] text-center">找不到符合的幣種</div>}
        {searchQuery.trim() && !allSymbols.some(s => s.toLowerCase() === searchQuery.toLowerCase().trim()) && (
          <button onClick={handleAddCustomSymbol}
            className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm text-[#2962FF] hover:bg-[#2A2E39] border-t border-[#2A2E39]">
            <Plus className="w-4 h-4" />Add "{searchQuery.toUpperCase().trim()}"
          </button>
        )}
      </div>
    </div>
    );
  };

  // ── MTF Panel ──
  const MTFPanel = () => (
    <div className="p-4 border-b border-[#2A2E39]">
      <div className="text-[10px] font-bold text-[#787B86] uppercase tracking-widest mb-3">多時間框架確認</div>
      {mtfLoading ? (
        <div className="flex justify-center py-4"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#2962FF]" /></div>
      ) : (
        <div className="space-y-2">
          {mtfSignals.map(s => {
            const divColor =
              s.divergence === 'CONFIRMED_BULL' ? 'text-[#089981]' :
              s.divergence === 'CONFIRMED_BEAR' ? 'text-[#F23645]' :
              s.divergence === 'WARNING_BULL'   ? 'text-[#FFC107]' :
              s.divergence === 'WARNING_BEAR'   ? 'text-[#FFC107]' : 'text-[#2A2E39]';
            const divText =
              s.divergence === 'CONFIRMED_BULL' ? '✅↑' :
              s.divergence === 'CONFIRMED_BEAR' ? '✅↓' :
              s.divergence === 'WARNING_BULL'   ? '⚠️↑' :
              s.divergence === 'WARNING_BEAR'   ? '⚠️↓' : '';
            return (
              <div key={s.tf} className="flex items-center justify-between gap-2">
                <span className="text-sm text-[#787B86] w-10">{s.tf.toUpperCase()}</span>
                <div className="flex-1 mx-1 h-1.5 bg-[#2A2E39] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${s.direction === 'LONG' ? 'bg-[#089981]' : s.direction === 'SHORT' ? 'bg-[#F23645]' : 'bg-[#787B86]'}`}
                    style={{ width: s.direction === 'LONG' ? '100%' : s.direction === 'SHORT' ? '100%' : '50%' }} />
                </div>
                <span className={`text-xs font-bold w-14 text-right ${s.direction === 'LONG' ? 'text-[#089981]' : s.direction === 'SHORT' ? 'text-[#F23645]' : 'text-[#787B86]'}`}>
                  {s.direction}
                </span>
                <span className={`text-xs w-8 text-right ${divColor}`}>{divText}</span>
              </div>
            );
          })}
          {mtfSignals.length > 0 && (() => {
            const longs  = mtfSignals.filter(s => s.direction === 'LONG').length;
            const shorts = mtfSignals.filter(s => s.direction === 'SHORT').length;
            const consensus = longs === 3 ? '🟢 全面做多' : shorts === 3 ? '🔴 全面做空' : longs > shorts ? '🟡 偏多' : shorts > longs ? '🟡 偏空' : '⚪ 中性';
            const anyDivConfirmed = mtfSignals.some(s => s.divergence?.startsWith('CONFIRMED'));
            const anyDivWarning   = mtfSignals.some(s => s.divergence?.startsWith('WARNING'));
            return (
              <div className="mt-3 space-y-1.5">
                <div className="p-2 bg-[#1E222D] rounded-lg text-center text-xs font-medium text-[#D1D4DC]">
                  共識：{consensus}
                </div>
                {(anyDivConfirmed || anyDivWarning) && (
                  <div className={`p-2 rounded-lg text-center text-xs font-medium ${anyDivConfirmed ? 'bg-[#089981]/10 text-[#089981]' : 'bg-[#FFC107]/10 text-[#FFC107]'}`}>
                    RSI 背離：{anyDivConfirmed ? '✅ 已確立' : '⚠️ 徵兆中'}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );

  // ── Alerts Panel ── 獨立 component 避免 re-render 導致鍵盤收起
  const AlertsPanel = React.memo(({ symbol, currentPrice, alerts, notifPermission, requestPermission, addAlert, removeAlert, clearTriggered }: {
    symbol: string; currentPrice: number; alerts: any[]; notifPermission: string;
    requestPermission: () => void; addAlert: (s: string, p: number, c: 'above' | 'below') => void;
    removeAlert: (id: string) => void; clearTriggered: () => void;
  }) => {
    const [localPrice, setLocalPrice] = React.useState('');
    const [localCond,  setLocalCond]  = React.useState<'above' | 'below'>('above');

    const handleAdd = () => {
      const price = parseFloat(localPrice);
      if (!price || price <= 0) return;
      addAlert(symbol, price, localCond);
      setLocalPrice('');
    };

    return (
      <div className="p-4 border-b border-[#2A2E39]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-bold text-[#787B86] uppercase tracking-widest">價格警報</div>
          {notifPermission !== 'granted' && (
            <button onClick={requestPermission} className="text-xs text-[#2962FF] hover:underline">啟用通知</button>
          )}
        </div>
        <div className="flex gap-2 mb-3">
          <select value={localCond} onChange={e => setLocalCond(e.target.value as 'above' | 'below')}
            className="bg-[#1E222D] border border-[#2A2E39] text-[#D1D4DC] text-xs rounded-md px-2 py-1.5 outline-none shrink-0">
            <option value="above">突破</option>
            <option value="below">跌破</option>
          </select>
          <input
            type="number"
            placeholder={`目前 ${formatPriceString(currentPrice)}`}
            value={localPrice}
            onChange={e => setLocalPrice(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            className="flex-1 bg-[#1E222D] border border-[#2A2E39] focus:border-[#2962FF] text-[#D1D4DC] text-xs rounded-md px-2 py-1.5 outline-none min-w-0"
          />
          <button onClick={handleAdd}
            className="bg-[#2962FF] hover:bg-[#2962FF]/90 text-white text-xs px-2.5 py-1.5 rounded-md font-medium shrink-0">
            <Bell className="w-3.5 h-3.5" />
          </button>
        </div>
        {alerts.filter((a: any) => a.symbol === symbol).length === 0 ? (
          <div className="text-xs text-[#787B86] text-center py-3">尚無警報</div>
        ) : (
          <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
            {alerts.filter((a: any) => a.symbol === symbol).map((a: any) => (
              <div key={a.id} className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs ${a.triggered ? 'bg-[#2A2E39]/50 opacity-60' : 'bg-[#1E222D]'}`}>
                <span className={a.condition === 'above' ? 'text-[#089981]' : 'text-[#F23645]'}>
                  {a.condition === 'above' ? '↑' : '↓'} <PriceText price={a.price} />
                </span>
                <div className="flex items-center gap-1.5">
                  {a.triggered && <span className="text-[#787B86]">已觸發</span>}
                  <button onClick={() => removeAlert(a.id)} className="text-[#787B86] hover:text-[#F23645]">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {alerts.some((a: any) => a.triggered) && (
          <button onClick={clearTriggered} className="mt-2 text-xs text-[#787B86] hover:text-[#D1D4DC] flex items-center gap-1">
            <Trash2 className="w-3 h-3" />清除已觸發
          </button>
        )}
      </div>
    );
  });

  // ── 掃描器新增幣種 mini input ──
  const ScannerAddSymbol = React.memo(({ onAdd }: { onAdd: (s: string) => void }) => {
    const [val, setVal] = React.useState('');
    const submit = () => {
      const s = val.toUpperCase().trim();
      if (!s) return;
      onAdd(s.endsWith('USDT') ? s : s + 'USDT');
      setVal('');
    };
    return (
      <div className="flex gap-1.5 mt-1.5">
        <input value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="新增幣種 e.g. SUI"
          className="flex-1 bg-[#1E222D] border border-[#2A2E39] focus:border-[#2962FF] text-[#D1D4DC] text-[10px] rounded px-2 py-1 outline-none min-w-0" />
        <button onClick={submit}
          className="bg-[#2962FF]/20 border border-[#2962FF]/40 text-[#2962FF] text-[10px] px-2 py-1 rounded font-medium shrink-0">+</button>
      </div>
    );
  });

  // ── Funding Rate Bar（只有抓到合約資料才顯示整行）──
  const FundingBar = () => {
    if (!fundingData) return null;
    return (
      <div className="flex items-center gap-3 px-4 py-1.5 bg-[#0F1117] border-b border-[#2A2E39] text-xs overflow-x-auto custom-scrollbar shrink-0">
        <span className="text-[#787B86] shrink-0">資金費率</span>
        <span className={`font-mono font-medium shrink-0 ${fundingData.fundingRate > 0 ? 'text-[#F23645]' : 'text-[#089981]'}`}>
          {fundingData.fundingRate > 0 ? '+' : ''}{fundingData.fundingRate.toFixed(4)}%
        </span>
        {fundingData.longShortRatio !== null && (
          <>
            <span className="text-[#2A2E39] shrink-0">|</span>
            <span className="text-[#787B86] shrink-0">多空比</span>
            <span className={`font-mono font-medium shrink-0 ${fundingData.longShortRatio > 1 ? 'text-[#089981]' : 'text-[#F23645]'}`}>
              {fundingData.longShortRatio.toFixed(2)}
            </span>
            <div className="w-16 h-1.5 bg-[#F23645] rounded-full overflow-hidden shrink-0">
              <div className="h-full bg-[#089981] rounded-full"
                style={{ width: `${Math.min((fundingData.longShortRatio / (fundingData.longShortRatio + 1)) * 100, 100)}%` }} />
            </div>
          </>
        )}
        <span className="text-[#787B86] shrink-0">
          下次: {new Date(fundingData.nextFundingTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    );
  };

  // ── Right Panel Content ──
  const RightPanelContent = () => (
    <>
      {/* Strategy */}
      <div className="p-4 border-b border-[#2A2E39]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[10px] font-bold text-[#787B86] uppercase tracking-widest">Live Signal</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <select value={strategyId} onChange={e => setStrategyId(e.target.value)}
                className="appearance-none bg-[#1E222D] border border-[#2A2E39] text-[#D1D4DC] text-xs rounded-md pl-2 pr-8 py-1.5 cursor-pointer hover:bg-[#2A2E39] transition-colors font-medium outline-none focus:border-[#2962FF]">
                {STRATEGIES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[#787B86] pointer-events-none" />
            </div>
            <button onClick={handleRunStrategy} disabled={isStrategyRunning}
              className="flex items-center gap-1.5 bg-[#2962FF] hover:bg-[#2962FF]/90 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {isStrategyRunning ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Play className="w-4 h-4" />}
              Run
            </button>
          </div>
        </div>

        {/* 諧波形態結果 */}
        {strategyId === 'harmonics' && (harmonicPatterns.length > 0 ? (
          <div className="space-y-3">
            {harmonicPatterns.map((hp, idx) => {
              const color = hp.direction === 'LONG' ? '#089981' : '#F23645';
              const statusIcon = hp.status === 'CONFIRMED' ? '✅' : hp.status === 'PRZ_TOUCHED' ? '🎯' : hp.status === 'ACTIVE' ? '⚡' : '🆕';
              return (
                <div key={idx} className="rounded-lg border p-3 space-y-2"
                  style={{ borderColor: `${color}30`, background: `${color}08` }}>
                  {/* 形態標題列 */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold" style={{ color }}>{hp.name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${hp.direction === 'LONG' ? 'bg-[#089981]/10 text-[#089981]' : 'bg-[#F23645]/10 text-[#F23645]'}`}>
                        {hp.direction}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px]">{statusIcon}</span>
                      <span className="text-[10px] text-[#787B86]">{hp.status}</span>
                    </div>
                  </div>
                  {/* 評分列 */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-[#2A2E39] rounded-full h-1.5">
                      <div className="h-full rounded-full" style={{ width: `${hp.score}%`, background: color }} />
                    </div>
                    <span className="text-xs font-bold text-[#D1D4DC] shrink-0">{hp.score}/100</span>
                  </div>
                  {/* 確認條件 */}
                  <div className="flex gap-2 text-[10px]">
                    <span className={hp.quality >= 75 ? 'text-[#089981]' : 'text-[#787B86]'}>吻合{hp.quality.toFixed(0)}%</span>
                    <span className={(hp.rsiBull || hp.rsiBear) ? 'text-[#089981]' : 'text-[#787B86]'}>RSI背離{(hp.rsiBull || hp.rsiBear) ? '✓' : '–'}</span>
                    <span className={hp.reversalCandle ? 'text-[#089981]' : 'text-[#787B86]'}>反轉K{hp.reversalCandle ? '✓' : '–'}</span>
                  </div>
                  {/* 價格資訊 */}
                  <div className="h-px bg-[#2A2E39]" />
                  <div className="space-y-1">
                    {[
                      { label: 'PRZ', node: <><PriceText price={hp.prz_low} />–<PriceText price={hp.prz_high} /></>, color: 'text-white' },
                      { label: 'Stop（C點）', node: <PriceText price={hp.stop} />, color: 'text-[#F23645]' },
                      { label: 'T1 保守', node: <PriceText price={hp.target1} />, color: 'text-[#089981]' },
                      { label: 'T2 標準', node: <PriceText price={hp.target2} />, color: 'text-[#089981]' },
                      { label: 'T3 B點', node: <PriceText price={hp.target3} />, color: 'text-[#4CAF50]' },
                      { label: 'R/R(T2)', node: <span>{hp.rr.toFixed(2)}</span>, color: 'text-[#D1D4DC]' },
                    ].map(({ label, node, color: c }) => (
                      <div key={label} className="flex justify-between items-center">
                        <span className="text-[11px] text-[#787B86]">{label}</span>
                        <span className={`text-[11px] font-mono ${c}`}>{node}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-6 text-sm text-[#787B86]">
            {isStrategyRunning ? '偵測中...' : '目前 K 線無符合的諧波形態'}
          </div>
        ))}

        {/* ── 目前套用的參數名稱 ── */}
        {strategyId === 'snr_fvg' && chartPreset && (
          <div className="flex items-center justify-between bg-[#08998118] border border-[#089981] rounded-lg px-3 py-2 mb-2">
            <span className="text-[10px] text-[#787B86]">套用中</span>
            <span className="text-[12px] text-[#089981] font-bold">{chartPreset.name}</span>
            <button onClick={() => { setChartPreset(null); try { localStorage.removeItem('qv_chart_preset'); } catch {} }}
              className="text-[10px] text-[#787B86] hover:text-white ml-2">✕</button>
          </div>
        )}

        {strategyId === 'snr_fvg' && snrFvgResult && (
          <div className="space-y-3">
            {snrFvgResult.signal ? (() => {
              const sig = snrFvgResult.signal!;
              const color = sig.direction === 'LONG' ? '#089981' : '#F23645';
              return (
                <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: `${color}30`, background: `${color}08` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold" style={{ color }}>LQ 獵取</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${sig.direction === 'LONG' ? 'bg-[#089981]/10 text-[#089981]' : 'bg-[#F23645]/10 text-[#F23645]'}`}>{sig.direction}</span>
                    </div>
                    <span className="text-[10px] text-[#787B86]">來源: {sig.source}</span>
                  </div>
                  <div className="h-px bg-[#2A2E39]" />
                  <div className="space-y-1">
                    {[
                      { label: '入場', value: <PriceText price={sig.entry} />, c: 'text-white' },
                      { label: '止損', value: <PriceText price={sig.stop} />, c: 'text-[#F23645]' },
                      { label: '目標 (1:1)', value: <PriceText price={sig.target} />, c: 'text-[#089981]' },
                      { label: 'R/R', value: <span>1.00</span>, c: 'text-[#D1D4DC]' },
                    ].map(({ label, value, c }) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-[11px] text-[#787B86]">{label}</span>
                        <span className={`text-[11px] font-mono ${c}`}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })() : (
              <div className="space-y-2">
                <div className="text-xs text-[#787B86] text-center py-2">
                  {snrFvgResult.inBull ? '✅ 在多頭 SNR/FVG 區域，等待 LQ 訊號' :
                   snrFvgResult.inBear ? '✅ 在空頭 SNR/FVG 區域，等待 LQ 訊號' :
                   '目前不在任何 SNR/FVG 區域'}
                </div>
                <div className="flex gap-3 text-[11px] justify-center">
                  <span className="text-[#787B86]">SNR 區域: <span className="text-white">{snrFvgResult.snrLevels.length}</span></span>
                  <span className="text-[#787B86]">FVG 缺口: <span className="text-white">{snrFvgResult.fvgZones.length}</span></span>
                </div>
              </div>
            )}
          </div>
        )}

        {strategyId !== 'harmonics' && strategyId !== 'snr_fvg' && strategyResult ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#787B86]">Time</span>
              <span className="text-sm font-medium text-[#D1D4DC]">
                {new Date(strategyResult.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#787B86]">Direction</span>
              <span className={`px-2 py-1 rounded text-xs font-bold ${strategyResult.direction === 'LONG' ? 'bg-[#089981]/10 text-[#089981]' : 'bg-[#F23645]/10 text-[#F23645]'}`}>
                {strategyResult.direction}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-[#787B86] shrink-0">Regime</span>
              <span className="text-sm font-medium text-[#D1D4DC] truncate text-right">{strategyResult.regime}</span>
            </div>
            <div className="h-px bg-[#2A2E39]" />
            <div className="space-y-2">
              {[
                { label: 'Entry Zone', node: <><PriceText price={strategyResult.entry_low} /> - <PriceText price={strategyResult.entry_high} /></>, color: 'text-white' },
                { label: 'Target',    node: <PriceText price={strategyResult.target} />, color: 'text-[#089981]' },
                { label: 'Stop Loss', node: <PriceText price={strategyResult.stop} />,   color: 'text-[#F23645]' },
                { label: 'R/R',       node: <span>{strategyResult.rr.toFixed(2)}</span>, color: 'text-[#D1D4DC]' },
              ].map(({ label, node, color }) => (
                <div key={label} className="flex justify-between items-center gap-2">
                  <span className="text-sm text-[#787B86] shrink-0">{label}</span>
                  <span className={`text-sm font-mono text-right ${color}`}>{node}</span>
                </div>
              ))}
            </div>
            {strategyResult.logs && strategyResult.logs.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-3.5 h-3.5 text-[#787B86]" />
                  <span className="text-[10px] font-bold text-[#787B86] uppercase tracking-wider">Strategy Logs</span>
                </div>
                <div className="bg-[#1E222D] rounded-lg p-2.5 space-y-1.5 max-h-52 overflow-y-auto border border-[#2A2E39] custom-scrollbar">
                  {strategyResult.logs.map((log, i) => (
                    <div key={i} className="text-[11px] font-mono leading-relaxed break-words">
                      <span className="text-[#787B86] mr-2">[{i.toString().padStart(2, '0')}]</span>
                      <span className={log.includes('🔥') || log.includes('✅') || log.includes('🟢') ? 'text-[#089981]' : log.includes('❌') || log.includes('⚠') || log.includes('🔴') ? 'text-[#F23645]' : 'text-[#D1D4DC]'}>
                        {log}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : strategyId !== 'harmonics' ? (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[#1E222D] flex items-center justify-center">
              <AlertCircle className="w-6 h-6 text-[#787B86]" />
            </div>
            <p className="text-sm text-[#787B86]">點擊 Run Strategy 分析市場</p>
          </div>
        ) : null}
      </div>
      <MTFPanel />

      {/* ── 諧波掃描器 ── */}
      <div className="p-4 border-b border-[#2A2E39]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-bold text-[#787B86] uppercase tracking-widest">諧波掃描器</div>
          <button onClick={() => setShowScanner(p => !p)}
            className="text-xs text-[#2962FF] hover:underline">{showScanner ? '收起' : '展開'}</button>
        </div>
        {showScanner && (
          <div className="space-y-3">
            {/* 幣種選擇 */}
            {(() => {
              const DEFAULT_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','AAVEUSDT','MATICUSDT','FILUSDT','TRXUSDT','FTMUSDT','PEPEUSDT'];
              const allScanSyms = Array.from(new Set([...DEFAULT_SCAN_SYMS, ...scanSymbols.filter(s => !DEFAULT_SCAN_SYMS.includes(s))]));
              return (
              <div>
                <div className="text-[10px] text-[#787B86] mb-1.5">選擇掃描幣種</div>
                <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto custom-scrollbar">
                  {allScanSyms.map(sym => {
                    const active = scanSymbols.includes(sym);
                    const isCustom = !DEFAULT_SCAN_SYMS.includes(sym);
                    return (
                      <div key={sym} className="relative group">
                        <button onClick={() => setScanSymbols(p => active ? p.filter(s => s !== sym) : [...p, sym])}
                          className={`px-1.5 py-0.5 text-[10px] rounded border font-medium transition-all pr-3 ${active ? 'bg-[#2962FF]/15 border-[#2962FF]/40 text-[#2962FF]' : 'bg-transparent border-[#2A2E39] text-[#787B86]'}`}>
                          {sym.replace('USDT','')}
                        </button>
                        {isCustom && (
                          <button onClick={() => setScanSymbols(p => p.filter(s => s !== sym))}
                            className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#F23645] text-white rounded-full text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* 新增自訂幣種 */}
                <ScannerAddSymbol onAdd={sym => { if (!allScanSyms.includes(sym)) setScanSymbols(p => [...p, sym]); }} />
                <div className="flex gap-2 mt-1.5">
                  <button onClick={() => setScanSymbols(allScanSyms)}
                    className="text-[10px] text-[#787B86] hover:text-[#D1D4DC]">全選</button>
                  <button onClick={() => setScanSymbols(favorites)}
                    className="text-[10px] text-[#787B86] hover:text-[#D1D4DC]">用我的最愛</button>
                  <button onClick={() => setScanSymbols([])}
                    className="text-[10px] text-[#787B86] hover:text-[#D1D4DC]">清除</button>
                </div>
              </div>
              );
            })()}
            <button onClick={() => handleScan(scanSymbols)} disabled={isScanning || scanSymbols.length === 0}
              className="w-full flex items-center justify-center gap-2 bg-[#2962FF] hover:bg-[#2962FF]/90 disabled:opacity-50 text-white text-xs px-3 py-2 rounded-lg font-medium transition-colors">
              {isScanning ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />掃描中...</> : `掃描 ${scanSymbols.length} 個幣種`}
            </button>
            {/* 掃描結果 */}
            {scanResults.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] text-[#787B86]">找到 {scanResults.length} 個形態</div>
                {scanResults.map(({ symbol: sym, pattern: p }) => {
                  const color = p.direction === 'LONG' ? '#089981' : '#F23645';
                  const statusIcon = p.status === 'CONFIRMED' ? '✅' : p.status === 'PRZ_TOUCHED' ? '🎯' : p.status === 'ACTIVE' ? '⚡' : '🆕';
                  return (
                    <button key={sym} onClick={() => selectSymbol(sym, true)}
                      className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#1E222D] hover:bg-[#2A2E39] transition-colors border border-[#2A2E39] text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-[#D1D4DC]">{sym.replace('USDT','')}</span>
                        <span className="text-[10px] font-medium" style={{ color }}>{p.direction}</span>
                        <span className="text-[10px] text-[#787B86]">{p.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px]">{statusIcon}</span>
                        <span className="text-[10px] font-bold" style={{ color }}>{p.score}/100</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {!isScanning && scanSymbols.length > 0 && scanResults.length === 0 && (
              <div className="text-xs text-[#787B86] text-center py-2">尚未掃描或無符合形態</div>
            )}
          </div>
        )}
      </div>

      {/* AlertsPanel 只在手機信號頁顯示（桌機用鈴鐺按鈕開關） */}
      <div className="lg:hidden">
        <AlertsPanel symbol={symbol} currentPrice={currentPrice} alerts={alerts} notifPermission={notifPermission} requestPermission={requestPermission} addAlert={addAlert} removeAlert={removeAlert} clearTriggered={clearTriggered} />
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#D1D4DC] font-sans flex flex-col selection:bg-[#2962FF]/30" style={{ paddingTop: "env(safe-area-inset-top)" }}>

      {/* ── Header ── */}
      <header className="hidden lg:flex border-b border-[#2A2E39] bg-[#131722] flex-col lg:flex-row lg:items-center justify-between shrink-0 shadow-sm z-20">
        <div className="flex items-center justify-between h-14 px-4 w-full lg:w-auto shrink-0">
          <div className="flex items-center gap-2 text-[#D1D4DC] font-bold text-xl tracking-tight">
            <div className="w-8 h-8 rounded-lg bg-[#2962FF] flex items-center justify-center shadow-lg shadow-[#2962FF]/20">
              <Activity className="w-5 h-5 text-white" />
            </div>
            QuantView
          </div>
          <div className="flex items-center gap-2 lg:hidden">
            {/* Mobile: bell icon shows alert count */}
            <button onClick={() => setMobileTab('alerts')}
              className="relative p-2 text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#1E222D] rounded-lg transition-colors">
              <Bell className="w-5 h-5" />
              {alerts.filter(a => a.symbol === symbol && !a.triggered).length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[#2962FF] text-white text-[9px] rounded-full flex items-center justify-center font-bold">
                  {alerts.filter(a => a.symbol === symbol && !a.triggered).length}
                </span>
              )}
            </button>
            <button className="p-2 text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#1E222D] rounded-lg transition-colors">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 overflow-x-auto custom-scrollbar px-4 pb-3 lg:pb-0 lg:px-0 lg:h-14 w-full lg:w-auto">
          {/* Symbol selector */}
          <div className="relative group shrink-0">
            <select value={symbol} onChange={e => selectSymbol(e.target.value)}
              className="bg-transparent text-[#D1D4DC] font-semibold text-lg outline-none cursor-pointer hover:text-white transition-colors appearance-none pr-6">
              {Array.from(new Set(favorites.includes(symbol) ? favorites : [symbol, ...favorites])).map(s => (
                <option key={s} value={s} className="bg-[#131722] text-sm">{s}</option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-[#787B86] absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          <div className="h-6 w-px bg-[#2A2E39] shrink-0" />

          {/* Timeframe */}
          <div className="flex items-center gap-1 bg-[#1E222D] p-1 rounded-lg border border-[#2A2E39] shrink-0">
            {INTERVALS.map(int => (
              <button key={int.value} onClick={() => setInterval(int.value)}
                className={`px-3 py-1 text-sm rounded-md transition-all duration-200 font-medium ${interval === int.value ? 'bg-[#2A2E39] text-white shadow-sm' : 'text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#2A2E39]/50'}`}>
                {int.label}
              </button>
            ))}
          </div>

          <div className="h-6 w-px bg-[#2A2E39] shrink-0" />

          {/* Chart type */}
          <div className="flex items-center gap-1 bg-[#1E222D] p-1 rounded-lg border border-[#2A2E39] shrink-0">
            <button onClick={() => setChartType('candles')}
              className={`px-2 py-1 text-xs rounded-md font-medium transition-all ${chartType === 'candles' ? 'bg-[#2A2E39] text-white' : 'text-[#787B86] hover:text-[#D1D4DC]'}`}>K線</button>
            <button onClick={() => setChartType('line')}
              className={`px-2 py-1 text-xs rounded-md font-medium transition-all ${chartType === 'line' ? 'bg-[#2A2E39] text-white' : 'text-[#787B86] hover:text-[#D1D4DC]'}`}>折線</button>
          </div>

          <div className="lg:block hidden h-6 w-px bg-[#2A2E39] shrink-0" />

          {/* Indicators - 桌機顯示，手機移到底部 */}
          <div className="hidden lg:flex items-center gap-1.5 shrink-0">
            {[
              { key: 'sma',      label: 'SMA',  active: showSMA,      toggle: () => setShowSMA(p => !p),      color: '#2962FF', Icon: TrendingUp },
              { key: 'rsi',      label: 'RSI',  active: showRSI,      toggle: () => setShowRSI(p => !p),      color: '#E91E63', Icon: BarChart2  },
              { key: 'macd',     label: 'MACD', active: showMACD,     toggle: () => setShowMACD(p => !p),     color: '#FF9800', Icon: Activity   },
              { key: 'bb',       label: 'BB',   active: showBB,       toggle: () => setShowBB(p => !p),       color: '#9C27B0', Icon: TrendingUp },
              { key: 'sr',       label: 'S/R',  active: showSR,       toggle: () => setShowSR(p => !p),       color: '#607D8B', Icon: LayoutGrid },
              { key: 'volspike', label: '爆量', active: showVolSpike, toggle: () => setShowVolSpike(p => !p), color: '#FF9800', Icon: BarChart2  },
            ].map(({ key, label, active, toggle, color, Icon }) => (
              <button key={key} onClick={toggle}
                style={active ? { borderColor: `${color}40`, color, background: `${color}15` } : {}}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border transition-all duration-200 font-medium ${active ? '' : 'bg-transparent border-transparent text-[#787B86] hover:bg-[#1E222D] hover:text-[#D1D4DC]'}`}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>

          <div className="hidden lg:block h-6 w-px bg-[#2A2E39] shrink-0" />

          {/* Strategy selector - 桌機顯示，手機移到底部 */}
          <div className="hidden lg:flex relative shrink-0 items-center gap-1.5">
            <span className="text-xs text-[#787B86] shrink-0">策略</span>
            <div className="relative">
              <select value={strategyId} onChange={e => setStrategyId(e.target.value)}
                className="bg-[#1E222D] border border-[#2A2E39] text-[#D1D4DC] text-xs rounded-lg px-2.5 py-1.5 outline-none cursor-pointer appearance-none pr-6 hover:border-[#2962FF] transition-colors">
                {STRATEGIES.map(s => <option key={s.id} value={s.id} className="bg-[#131722]">{s.name}</option>)}
              </select>
              <ChevronDown className="w-3 h-3 text-[#787B86] absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <div className="hidden lg:block h-6 w-px bg-[#2A2E39] shrink-0" />

          {/* Search */}
          <div className="relative shrink-0" ref={searchRef}>
            <div className="relative flex items-center">
              <Search className="w-4 h-4 text-[#787B86] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜尋幣種..."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setIsSearchOpen(true); }}
                onFocus={() => setIsSearchOpen(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && filteredSymbols.length > 0) selectSymbol(filteredSymbols[0]);
                  if (e.key === 'Escape') { setIsSearchOpen(false); setSearchQuery(''); }
                }}
                className="bg-[#1E222D] border border-[#2A2E39] focus:border-[#2962FF] text-[#D1D4DC] text-sm rounded-lg pl-8 pr-7 py-1.5 w-36 outline-none transition-colors placeholder-[#4B5263]"
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setIsSearchOpen(false); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#787B86] hover:text-[#D1D4DC]">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {isSearchOpen && <SearchDropdown inputRef={searchInputRef} />}
          </div>
        </div>

        <div className="hidden lg:flex items-center gap-2 px-4 shrink-0">
          <button onClick={() => setShowAlertPanel(p => !p)}
            className={`relative p-2 rounded-lg transition-colors ${showAlertPanel ? 'bg-[#2962FF]/10 text-[#2962FF]' : 'text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#1E222D]'}`}>
            <Bell className="w-5 h-5" />
            {alerts.filter(a => a.symbol === symbol && !a.triggered).length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[#2962FF] text-white text-[9px] rounded-full flex items-center justify-center font-bold">
                {alerts.filter(a => a.symbol === symbol && !a.triggered).length}
              </span>
            )}
          </button>
          <button className="p-2 text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#1E222D] rounded-lg transition-colors">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ── Funding Rate Bar ── */}
      <FundingBar />

      {/* ── Mobile 指標列 + 策略選單（資金費率下面）── */}
      <div className="lg:hidden bg-[#131722] border-b border-[#2A2E39] shrink-0">
        {/* 幣種 + 搜尋列 */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <div className="relative shrink-0">
            <select value={symbol} onChange={e => selectSymbol(e.target.value)}
              className="bg-transparent text-[#D1D4DC] font-bold text-base outline-none cursor-pointer appearance-none pr-5">
              {Array.from(new Set(favorites.includes(symbol) ? favorites : [symbol, ...favorites])).map(s => (
                <option key={s} value={s} className="bg-[#131722] text-sm">{s}</option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-[#787B86] absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <div className="relative flex-1" ref={mobileSearchRef}>
            <Search className="w-3.5 h-3.5 text-[#787B86] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={mobileSearchInputRef}
              type="text"
              placeholder="搜尋..."
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setIsSearchOpen(true); }}
              onFocus={() => setIsSearchOpen(true)}
              onKeyDown={e => {
                if (e.key === 'Enter' && filteredSymbols.length > 0) selectSymbol(filteredSymbols[0]);
                if (e.key === 'Escape') { setIsSearchOpen(false); setSearchQuery(''); }
              }}
              className="bg-[#1E222D] border border-[#2A2E39] focus:border-[#2962FF] text-[#D1D4DC] text-xs rounded-lg pl-7 pr-6 py-1.5 w-full outline-none placeholder-[#4B5263]"
            />
            {searchQuery && (
              <button onClick={() => { setSearchQuery(''); setIsSearchOpen(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#787B86]">
                <X className="w-3 h-3" />
              </button>
            )}
            {isSearchOpen && <SearchDropdown inputRef={mobileSearchInputRef} />}
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto custom-scrollbar">
          {/* 時間框架 */}
          {INTERVALS.map(int => (
            <button key={int.value} onClick={() => setInterval(int.value)}
              className={`px-2 py-1 text-xs rounded-md font-medium shrink-0 transition-all ${interval === int.value ? 'bg-[#2A2E39] text-white' : 'bg-transparent border border-[#2A2E39] text-[#787B86]'}`}>
              {int.label}
            </button>
          ))}
          <div className="h-4 w-px bg-[#2A2E39] shrink-0 mx-1" />
          {[
            { key: 'sma',      label: 'SMA',  active: showSMA,      toggle: () => setShowSMA(p => !p),      color: '#2962FF' },
            { key: 'rsi',      label: 'RSI',  active: showRSI,      toggle: () => setShowRSI(p => !p),      color: '#E91E63' },
            { key: 'macd',     label: 'MACD', active: showMACD,     toggle: () => setShowMACD(p => !p),     color: '#FF9800' },
            { key: 'bb',       label: 'BB',   active: showBB,       toggle: () => setShowBB(p => !p),       color: '#9C27B0' },
            { key: 'sr',       label: 'S/R',  active: showSR,       toggle: () => setShowSR(p => !p),       color: '#607D8B' },
            { key: 'volspike', label: '爆量', active: showVolSpike, toggle: () => setShowVolSpike(p => !p), color: '#FF9800' },
          ].map(({ key, label, active, toggle, color }) => (
            <button key={key} onClick={toggle}
              style={active ? { borderColor: `${color}40`, color, background: `${color}15` } : {}}
              className={`px-2 py-1 text-xs rounded-md border transition-all shrink-0 font-medium ${active ? '' : 'bg-transparent border-[#2A2E39] text-[#787B86]'}`}>
              {label}
            </button>
          ))}

        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">

        {/* Chart area — 手機只在 chart tab 顯示 */}
        <div className={`flex-1 flex flex-col min-w-0 border-b lg:border-b-0 lg:border-r border-[#2A2E39] bg-[#0B0E14] overflow-y-auto custom-scrollbar ${mobileTab !== 'chart' ? 'hidden lg:flex' : 'flex'}`}>
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2962FF]" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-[#F23645] bg-[#F23645]/5 m-8 rounded-xl border border-[#F23645]/20">
              <ShieldAlert className="w-6 h-6 mr-3" /><span className="font-medium">{error}</span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col p-4 gap-4">
              {/* Price header */}
              <div className="w-full h-[calc(100svh-240px)] lg:h-[500px] bg-[#131722] rounded-xl border border-[#2A2E39] p-4 pt-6 relative shrink-0 shadow-sm">
                <div className="absolute top-4 left-4 z-10 flex flex-col gap-1 pointer-events-none">
                  <div className="flex items-baseline gap-3 pointer-events-auto flex-wrap">
                    <div className="text-2xl font-bold text-white flex items-center gap-2">
                      {symbol}
                      <button onClick={e => toggleFavorite(e, symbol)} className="focus:outline-none hover:scale-110 transition-transform">
                        <Star className={`w-5 h-5 transition-colors ${favorites.includes(symbol) ? 'fill-[#FFC107] text-[#FFC107]' : 'text-[#787B86] hover:text-[#D1D4DC]'}`} />
                      </button>
                    </div>
                    <div className={`text-lg font-medium ${priceChange >= 0 ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                      <PriceText price={currentPrice} />
                      <span className="text-sm ml-2">
                        {priceChange >= 0 ? '+' : ''}<PriceText price={Math.abs(priceChange)} /> ({priceChangePct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                  <div className="text-sm text-[#787B86] flex items-center gap-2 font-medium">
                    <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {interval}</span>
                    <span>•</span><span>Binance</span>
                    {showVolSpike && volumeSpikes.size > 0 && <span className="text-[#FF9800] text-xs">⚡ {volumeSpikes.size} 爆量</span>}
                  </div>
                </div>

                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={strategyId === 'harmonics' ? harmonicChartData : chartData} margin={{ top: 70, right: 20, left: 20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E222D" vertical={false} />
                    <XAxis dataKey="timeStr" stroke="#434651" tick={{ fill: '#787B86', fontSize: 11, fontWeight: 500 }}
                      tickMargin={12} minTickGap={40} axisLine={false} tickLine={false} />
                    <YAxis domain={yDomain} stroke="#434651" tick={{ fill: '#787B86', fontSize: 11, fontWeight: 500 }}
                      tickFormatter={v => formatPriceString(v)} orientation="right" axisLine={false} tickLine={false} tickMargin={12} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1E222D', borderColor: '#2A2E39', borderRadius: '8px', color: '#D1D4DC', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.3)' }}
                      itemStyle={{ color: '#D1D4DC', fontSize: '13px', fontWeight: 500 }}
                      labelStyle={{ color: '#787B86', marginBottom: '6px', fontSize: '12px', fontWeight: 600 }}
                      formatter={(value: any, name: string, props: any) => {
                        if (name === 'Price') {
                          const { open, high, low, close } = props.payload;
                          return [`O:${formatPriceString(open)} H:${formatPriceString(high)} L:${formatPriceString(low)} C:${formatPriceString(close)}`, 'OHLC'];
                        }
                        if (typeof value === 'number') return [formatPriceString(value), name];
                        return [value, name];
                      }}
                    />

                    {/* Support/Resistance */}
                    {showSR && srLevels.resistance.map((v, i) => (
                      <ReferenceLine key={`r${i}`} y={v} stroke="#F23645" strokeDasharray="6 3" strokeWidth={1} strokeOpacity={0.6}
                        label={{ position: 'insideTopRight', value: `R ${formatPriceString(v)}`, fill: '#F23645', fontSize: 10 }} />
                    ))}
                    {showSR && srLevels.support.map((v, i) => (
                      <ReferenceLine key={`s${i}`} y={v} stroke="#089981" strokeDasharray="6 3" strokeWidth={1} strokeOpacity={0.6}
                        label={{ position: 'insideBottomRight', value: `S ${formatPriceString(v)}`, fill: '#089981', fontSize: 10 }} />
                    ))}

                    {/* Alert lines */}
                    {alerts.filter(a => a.symbol === symbol && !a.triggered).map(a => (
                      <ReferenceLine key={a.id} y={a.price} stroke="#FFC107" strokeDasharray="4 4" strokeWidth={1.5}
                        label={{ position: 'insideTopLeft', value: `🔔 ${formatPriceString(a.price)}`, fill: '#FFC107', fontSize: 11 }} />
                    ))}

                    {/* Strategy overlays */}
                    {strategyResult?.smcDetails && (
                      <ReferenceArea
                        {...({ fill: strategyResult.smcDetails.currentSession === 'Asia' ? '#2196F3' : strategyResult.smcDetails.currentSession === 'London' ? '#FFC107' : '#F44336', fillOpacity: 0.05, stroke: 'none' } as any)}
                      />
                    )}
                    {strategyResult && strategyResult.entry_low > 0 && strategyResult.entry_high > 0 && (
                      <ReferenceArea y1={strategyResult.entry_low} y2={strategyResult.entry_high}
                        {...({ fill: strategyResult.direction === 'LONG' ? '#089981' : '#F23645', fillOpacity: 0.15, stroke: 'none' } as any)} />
                    )}
                    {strategyResult && strategyResult.stop > 0 && (
                      <ReferenceLine y={strategyResult.stop} stroke="#F23645" strokeDasharray="4 4" strokeWidth={1.5}
                        label={{ position: 'insideBottomLeft', value: 'Stop', fill: '#F23645', fontSize: 12, fontWeight: 600 }} />
                    )}
                    {strategyResult && strategyResult.target > 0 && (
                      <ReferenceLine y={strategyResult.target} stroke="#089981" strokeDasharray="4 4" strokeWidth={1.5}
                        label={{ position: 'insideTopLeft', value: 'Target', fill: '#089981', fontSize: 12, fontWeight: 600 }} />
                    )}
                    {strategyResult?.smcDetails?.targetHigh > 0 && (
                      <ReferenceLine y={strategyResult.smcDetails.targetHigh} stroke="#FF9800" strokeDasharray="3 3"
                        label={{ position: 'insideTopLeft', value: `${strategyResult.smcDetails.targetSession} High`, fill: '#FF9800', fontSize: 11, fontWeight: 600 }} />
                    )}
                    {strategyResult?.smcDetails?.targetLow > 0 && (
                      <ReferenceLine y={strategyResult.smcDetails.targetLow} stroke="#FF9800" strokeDasharray="3 3"
                        label={{ position: 'insideBottomLeft', value: `${strategyResult.smcDetails.targetSession} Low`, fill: '#FF9800', fontSize: 11, fontWeight: 600 }} />
                    )}
                    {strategyResult?.smcDetails?.obLow > 0 && strategyResult?.smcDetails?.obHigh > 0 && (
                      <ReferenceArea y1={strategyResult.smcDetails.obLow} y2={strategyResult.smcDetails.obHigh}
                        {...({ fill: strategyResult.smcDetails.obType === 'BULLISH' ? '#089981' : '#F23645', fillOpacity: 0.3, stroke: strategyResult.smcDetails.obType === 'BULLISH' ? '#089981' : '#F23645', strokeWidth: 1 } as any)} />
                    )}

                    {/* BB */}
                    {showBB && <Line type="monotone" dataKey="bbUpper" stroke="#9C27B0" dot={false} strokeWidth={1} strokeDasharray="3 3" isAnimationActive={false} name="BB Upper" />}
                    {showBB && <Line type="monotone" dataKey="bbLower" stroke="#9C27B0" dot={false} strokeWidth={1} strokeDasharray="3 3" isAnimationActive={false} name="BB Lower" />}
                    {showBB && <Line type="monotone" dataKey="bbMiddle" stroke="#9C27B0" dot={false} strokeWidth={1} strokeOpacity={0.5} isAnimationActive={false} name="BB Middle" />}

                    {/* SNR+FVG 圖表標記 */}
                    {strategyId === 'snr_fvg' && snrFvgResult && (<>
                      {/* FVG 缺口：多頭藍色，空頭橘色 */}
                      {snrFvgResult.fvgZones.slice(0, 8).map((fvg, i) => (
                        <ReferenceArea key={`fvg${i}`} y1={fvg.bottom} y2={fvg.top}
                          {...({ fill: fvg.isBull ? '#2196F3' : '#FF9800', fillOpacity: 0.12, stroke: fvg.isBull ? '#2196F3' : '#FF9800', strokeWidth: 1, strokeDasharray: '3 3', strokeOpacity: 0.5 } as any)} />
                      ))}
                      {/* SNR 影線（白色虛線） */}
                      {snrFvgResult.snrLevels.slice(0, 10).map((snr, i) => (
                        <ReferenceLine key={`snrw${i}`} y={snr.wickY}
                          stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" strokeWidth={1}
                          label={{ position: snr.isRes ? 'insideTopRight' : 'insideBottomRight', value: snr.isRes ? 'R' : 'S', fill: 'rgba(255,255,255,0.4)', fontSize: 9 }} />
                      ))}
                      {/* SNR 實體（白色實線） */}
                      {snrFvgResult.snrLevels.filter(s => s.bodyActive).slice(0, 10).map((snr, i) => (
                        <ReferenceLine key={`snrb${i}`} y={snr.bodyY}
                          stroke="rgba(255,255,255,0.7)" strokeWidth={2}
                          label={{ position: snr.isRes ? 'insideTopLeft' : 'insideBottomLeft', value: snr.isRes ? '壓力' : '支撐', fill: 'rgba(255,255,255,0.6)', fontSize: 9 }} />
                      ))}
                      {/* LQ 訊號入場/止損/目標線 */}
                      {snrFvgResult.signal && (<>
                        <ReferenceLine y={snrFvgResult.signal.entry}
                          stroke="#2962FF" strokeDasharray="4 4" strokeWidth={1.5}
                          label={{ position: 'insideTopLeft', value: '入場', fill: '#2962FF', fontSize: 11, fontWeight: 600 }} />
                        <ReferenceLine y={snrFvgResult.signal.stop}
                          stroke="#F23645" strokeDasharray="4 4" strokeWidth={1.5}
                          label={{ position: snrFvgResult.signal.direction === 'LONG' ? 'insideBottomLeft' : 'insideTopLeft', value: 'Stop', fill: '#F23645', fontSize: 11, fontWeight: 600 }} />
                        <ReferenceLine y={snrFvgResult.signal.target}
                          stroke="#089981" strokeDasharray="4 4" strokeWidth={1.5}
                          label={{ position: snrFvgResult.signal.direction === 'LONG' ? 'insideTopLeft' : 'insideBottomLeft', value: 'T1(1:1)', fill: '#089981', fontSize: 11, fontWeight: 600 }} />
                      </>)}
                    </>)}

                    {/* Harmonic Patterns */}
                    {harmonicPatterns.length > 0 && (() => {
                      const hp = harmonicPatterns[0];
                      const color = hp.direction === 'LONG' ? '#089981' : '#F23645';
                      return (<>
                        {/* 次要形態 PRZ（淡色） */}
                        {harmonicPatterns.slice(1).map((hp2, idx) => {
                          const c2 = hp2.direction === 'LONG' ? '#089981' : '#F23645';
                          return <ReferenceArea key={`prz2_${idx}`} y1={hp2.prz_low} y2={hp2.prz_high}
                            {...({ fill: c2, fillOpacity: 0.06, stroke: c2, strokeWidth: 1, strokeDasharray: '2 6', strokeOpacity: 0.25 } as any)} />;
                        })}
                        {/* 主形態 PRZ */}
                        <ReferenceArea y1={hp.prz_low} y2={hp.prz_high}
                          {...({ fill: color, fillOpacity: 0.15, stroke: color, strokeWidth: 1, strokeDasharray: '4 2' } as any)} />
                        {/* Stop / Targets */}
                        <ReferenceLine y={hp.stop} stroke="#F23645" strokeDasharray="4 4" strokeWidth={1.5}
                          label={{ position: hp.direction === 'LONG' ? 'insideBottomLeft' : 'insideTopLeft', value: 'Stop(C)', fill: '#F23645', fontSize: 11, fontWeight: 600 }} />
                        <ReferenceLine y={hp.target1} stroke="#089981" strokeDasharray="6 3" strokeWidth={1}
                          label={{ position: 'insideTopLeft', value: 'T1', fill: '#089981', fontSize: 10 }} />
                        <ReferenceLine y={hp.target2} stroke="#089981" strokeDasharray="4 4" strokeWidth={1.5}
                          label={{ position: 'insideTopLeft', value: `T2 ${hp.name} ${hp.score}/100`, fill: '#089981', fontSize: 11, fontWeight: 600 }} />
                        <ReferenceLine y={hp.target3} stroke="#089981" strokeDasharray="2 5" strokeWidth={1} strokeOpacity={0.5}
                          label={{ position: 'insideTopLeft', value: 'T3(B)', fill: '#089981', fontSize: 10 }} />
                      </>);
                    })()}

                    {/* Candles / Line */}
                    {chartType === 'candles'
                      ? <Bar dataKey="range" shape={<CandlestickShape />} isAnimationActive={false} name="Price" />
                      : <Line type="monotone" dataKey="closePrice" stroke="#2962FF" dot={false} strokeWidth={2} isAnimationActive={false} name="Price" />}

                    {/* Volume spikes marker */}
                    {showVolSpike && chartData.map((d, i) => volumeSpikes.has(i) ? (
                      <ReferenceLine key={`vs${i}`} x={d.timeStr} stroke="#FF9800" strokeWidth={2} strokeOpacity={0.5} />
                    ) : null)}

                    {showSMA && <Line type="monotone" dataKey="sma20" stroke="#2962FF" dot={false} strokeWidth={1.5} isAnimationActive={false} name="SMA 20" />}
                    {showSMA && <Line type="monotone" dataKey="sma50" stroke="#FF9800" dot={false} strokeWidth={1.5} isAnimationActive={false} name="SMA 50" />}
                    {/* XABCD 折線 — 用 Customized SVG 畫真正的折線 */}
                    {strategyId === 'harmonics' && harmonicPatterns.length > 0 && (
                      <Customized component={(props: any) => {
                        const hp = harmonicPatterns[0];
                        const color = hp.direction === 'LONG' ? '#089981' : '#F23645';
                        const pts = [hp.X, hp.A, hp.B, hp.C, hp.D];
                        const labels = ['X','A','B','C','D'];
                        const data = props.formattedGraphicalItems?.[0]?.props?.points;
                        if (!data || data.length === 0) return null;
                        // 取得每個 XABCD 點的像素座標
                        const pixelPts = pts.map(pt => data[pt.index] ?? null).filter(Boolean);
                        if (pixelPts.length < 2) return null;
                        const polyPoints = pixelPts.map((p: any) => `${p.x},${p.y}`).join(' ');
                        return (
                          <g>
                            {/* 連線 */}
                            <polyline points={polyPoints} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                            {/* 各點圓點 + 標籤 */}
                            {pixelPts.map((p: any, i: number) => {
                              const label = labels[i];
                              const isD = label === 'D';
                              return (
                                <g key={label}>
                                  <circle cx={p.x} cy={p.y} r={isD ? 6 : 4} fill={color} stroke="#0B0E14" strokeWidth={1.5} />
                                  <text x={p.x} y={p.y - 10} textAnchor="middle" fill={color} fontSize={isD ? 12 : 10} fontWeight={isD ? 700 : 500} fontFamily="monospace">{label}</text>
                                </g>
                              );
                            })}
                          </g>
                        );
                      }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* ── 手機圖表頁策略面板 ── */}
              <div className="lg:hidden bg-[#131722] rounded-xl border border-[#2A2E39] px-3 py-3 shrink-0 space-y-3">
                {/* 策略切換按鈕 */}
                <div className="flex gap-2">
                  {STRATEGIES.map(s => (
                    <button key={s.id} onClick={() => setStrategyId(s.id)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${strategyId === s.id ? 'bg-[#2962FF] text-white' : 'bg-[#1E222D] text-[#787B86] border border-[#2A2E39]'}`}>
                      {s.id === 'ms_ob' ? 'MS+OB' : s.id === 'structural_reversal' ? 'PRZ' : s.id === 'smc_session' ? 'SMC' : s.id === 'snr_fvg' ? 'SNR+FVG' : '諧波'}
                    </button>
                  ))}
                </div>
                {strategyId === 'harmonics' ? (
                  harmonicPatterns.length > 0 ? (
                    <div className="space-y-2">
                      {harmonicPatterns.map((hp, idx) => {
                        const color = hp.direction === 'LONG' ? '#089981' : '#F23645';
                        const statusIcon = hp.status === 'CONFIRMED' ? '✅' : hp.status === 'PRZ_TOUCHED' ? '🎯' : hp.status === 'ACTIVE' ? '⚡' : '🆕';
                        return (
                          <div key={idx} className={`${idx > 0 ? 'pt-2 border-t border-[#2A2E39]' : ''}`}>
                            {/* 標題行 */}
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold" style={{ color }}>{hp.name}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${hp.direction === 'LONG' ? 'bg-[#089981]/10 text-[#089981]' : 'bg-[#F23645]/10 text-[#F23645]'}`}>{hp.direction}</span>
                                <span className="text-[10px]">{statusIcon}</span>
                                <span className="text-[10px] text-[#787B86]">{hp.status}</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div className="w-12 h-1 bg-[#2A2E39] rounded-full overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${hp.score}%`, background: color }} />
                                </div>
                                <span className="text-xs font-bold" style={{ color }}>{hp.score}</span>
                              </div>
                            </div>
                            {/* 數字行 */}
                            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-[11px]">
                              <div className="flex justify-between"><span className="text-[#787B86]">PRZ</span><span className="text-white font-mono"><PriceText price={hp.prz_low} /></span></div>
                              <div className="flex justify-between"><span className="text-[#787B86]">T1</span><span className="text-[#089981] font-mono"><PriceText price={hp.target1} /></span></div>
                              <div className="flex justify-between"><span className="text-[#787B86]">T2</span><span className="text-[#089981] font-mono"><PriceText price={hp.target2} /></span></div>
                              <div className="flex justify-between"><span className="text-[#787B86]">Stop</span><span className="text-[#F23645] font-mono"><PriceText price={hp.stop} /></span></div>
                              <div className="flex justify-between"><span className="text-[#787B86]">T3</span><span className="text-[#4CAF50] font-mono"><PriceText price={hp.target3} /></span></div>
                              <div className="flex justify-between"><span className="text-[#787B86]">R/R</span><span className="text-[#D1D4DC] font-mono">{hp.rr.toFixed(2)}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-[#787B86] text-center py-1">{isStrategyRunning ? '偵測中...' : '目前無符合諧波形態'}</div>
                  )
                ) : strategyId === 'snr_fvg' && snrFvgResult ? (
                  snrFvgResult.signal ? (
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${snrFvgResult.signal.direction === 'LONG' ? 'bg-[#089981]' : 'bg-[#F23645]'}`} />
                      <span className={`font-bold ${snrFvgResult.signal.direction === 'LONG' ? 'text-[#089981]' : 'text-[#F23645]'}`}>{snrFvgResult.signal.direction}</span>
                      <span className="text-[#787B86]">LQ 獵取</span>
                      <span className="text-[#2A2E39]">|</span>
                      <span className="text-[#787B86]">入場 <span className="text-white font-mono"><PriceText price={snrFvgResult.signal.entry} /></span></span>
                      <span className="text-[#2A2E39]">|</span>
                      <span className="text-[#787B86]">Stop <span className="text-[#F23645] font-mono"><PriceText price={snrFvgResult.signal.stop} /></span></span>
                      <span className="text-[#2A2E39]">|</span>
                      <span className="text-[#787B86]">T1 <span className="text-[#089981] font-mono"><PriceText price={snrFvgResult.signal.target} /></span></span>
                    </div>
                  ) : (
                    <div className="text-xs text-[#787B86] text-center py-1">
                      {snrFvgResult.inBull ? '在多頭區域，等待 LQ 訊號' : snrFvgResult.inBear ? '在空頭區域，等待 LQ 訊號' : '不在 SNR/FVG 區域'}
                    </div>
                  )
                ) : strategyResult && strategyResult.direction !== 'NEUTRAL' ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${strategyResult.direction === 'LONG' ? 'bg-[#089981]' : 'bg-[#F23645]'}`} />
                      <span className={`text-sm font-bold ${strategyResult.direction === 'LONG' ? 'text-[#089981]' : 'text-[#F23645]'}`}>{strategyResult.direction}</span>
                    </div>
                    <span className="text-[#2A2E39]">|</span>
                    <span className="text-xs text-[#787B86]">R/R <span className="text-[#D1D4DC] font-mono">{strategyResult.rr.toFixed(2)}</span></span>
                    <span className="text-[#2A2E39]">|</span>
                    <span className="text-xs text-[#787B86]">Stop <span className="text-[#F23645] font-mono"><PriceText price={strategyResult.stop} /></span></span>
                    <span className="text-[#2A2E39]">|</span>
                    <span className="text-xs text-[#787B86]">Target <span className="text-[#089981] font-mono"><PriceText price={strategyResult.target} /></span></span>
                  </div>
                ) : (
                  <div className="text-xs text-[#787B86] text-center py-1">{isStrategyRunning ? '分析中...' : '尚無信號'}</div>
                )}
              </div>

              {/* RSI */}
              {showRSI && (
                <div className="h-40 lg:h-48 bg-[#131722] rounded-xl border border-[#2A2E39] p-4 shrink-0 shadow-sm relative">
                  <div className="absolute top-4 left-4 z-10 text-sm font-semibold text-[#E91E63]">RSI (14)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 20, right: 20, left: 20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1E222D" vertical={false} />
                      <XAxis dataKey="timeStr" hide />
                      <YAxis domain={[0, 100]} stroke="#434651" tick={{ fill: '#787B86', fontSize: 11 }} orientation="right" ticks={[30, 50, 70]} axisLine={false} tickLine={false} tickMargin={12} />
                      <Tooltip contentStyle={{ backgroundColor: '#1E222D', borderColor: '#2A2E39', borderRadius: '8px' }} itemStyle={{ fontSize: '13px' }} labelStyle={{ color: '#787B86', fontSize: '12px' }} />
                      <Line type="monotone" dataKey={() => 70} stroke="#787B86" strokeDasharray="4 4" dot={false} strokeWidth={1} isAnimationActive={false} />
                      <Line type="monotone" dataKey={() => 30} stroke="#787B86" strokeDasharray="4 4" dot={false} strokeWidth={1} isAnimationActive={false} />
                      <Line type="monotone" dataKey="rsi" stroke="#E91E63" dot={false} strokeWidth={1.5} isAnimationActive={false} name="RSI" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* MACD */}
              {showMACD && (
                <div className="h-40 lg:h-48 bg-[#131722] rounded-xl border border-[#2A2E39] p-4 shrink-0 shadow-sm relative">
                  <div className="absolute top-4 left-4 z-10 text-sm font-semibold text-[#FF9800]">MACD (12, 26, 9)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 20, right: 20, left: 20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1E222D" vertical={false} />
                      <XAxis dataKey="timeStr" hide />
                      <YAxis stroke="#434651" tick={{ fill: '#787B86', fontSize: 11 }} orientation="right" axisLine={false} tickLine={false} tickMargin={12} />
                      <Tooltip contentStyle={{ backgroundColor: '#1E222D', borderColor: '#2A2E39', borderRadius: '8px' }} itemStyle={{ fontSize: '13px' }} labelStyle={{ color: '#787B86', fontSize: '12px' }} />
                      <Bar dataKey="macdHist" isAnimationActive={false} name="Histogram">
                        {chartData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.macdHist > 0 ? '#089981' : '#F23645'} fillOpacity={0.7} />)}
                      </Bar>
                      <Line type="monotone" dataKey="macd" stroke="#2962FF" dot={false} strokeWidth={1.5} isAnimationActive={false} name="MACD" />
                      <Line type="monotone" dataKey="macdSignal" stroke="#FF9800" dot={false} strokeWidth={1.5} isAnimationActive={false} name="Signal" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Desktop Right Panel ── */}
        <div className="hidden lg:flex w-80 bg-[#131722] flex-col shrink-0 overflow-y-auto border-l border-[#2A2E39] custom-scrollbar">
          {showAlertPanel && <AlertsPanel symbol={symbol} currentPrice={currentPrice} alerts={alerts} notifPermission={notifPermission} requestPermission={requestPermission} addAlert={addAlert} removeAlert={removeAlert} clearTriggered={clearTriggered} />}
          <RightPanelContent />
        </div>

        {/* ── Mobile: Signal / Alerts / Backtest tabs ── */}
        {mobileTab !== 'chart' && (
          <div className="flex-1 lg:hidden bg-[#131722] overflow-y-auto custom-scrollbar pb-20">
            {mobileTab === 'signal' && <RightPanelContent />}
            {mobileTab === 'alerts' && <AlertsPanel symbol={symbol} currentPrice={currentPrice} alerts={alerts} notifPermission={notifPermission} requestPermission={requestPermission} addAlert={addAlert} removeAlert={removeAlert} clearTriggered={clearTriggered} />}
            {mobileTab === 'backtest' && <BacktestPanel />}
          </div>
        )}


      </div>

      {/* ── Mobile Bottom Tab Bar ── */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#131722] border-t border-[#2A2E39] flex items-center z-30"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {([
          { key: 'chart',    label: '圖表',  Icon: Activity   },
          { key: 'signal',   label: '信號',  Icon: TrendingUp },
          { key: 'alerts',   label: '警報',  Icon: Bell       },
          { key: 'backtest', label: '回測',  Icon: BarChart2  },
        ] as { key: MobileTab; label: string; Icon: any }[]).map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setMobileTab(key)}
            className={`flex-1 flex flex-col items-center justify-center py-3 gap-0.5 transition-colors relative ${mobileTab === key ? 'text-[#2962FF]' : 'text-[#787B86]'}`}>
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{label}</span>
            {key === 'alerts' && alerts.filter(a => a.symbol === symbol && !a.triggered).length > 0 && (
              <span className="absolute top-2 right-1/4 w-3.5 h-3.5 bg-[#2962FF] text-white text-[8px] rounded-full flex items-center justify-center font-bold">
                {alerts.filter(a => a.symbol === symbol && !a.triggered).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Bottom padding for mobile tab bar */}
      <div className="lg:hidden h-16" />

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #2A2E39; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #434651; }
      `}} />
    </div>
  );
}
