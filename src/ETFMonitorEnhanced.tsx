import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Star, CalendarDays, Target, RefreshCw, LineChart as LineChartIcon, TrendingDown, Percent, ArrowDownWideNarrow } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { motion, AnimatePresence } from "framer-motion";

/**
 * 优化版ETF定投监控系统 v2.1 (语法修正版)
 */

// 配置
const CONFIG = {
  watchlist: [
    { code: "513180", name: "恒生科技ETF", market: 1 },
    { code: "513100", name: "纳指100ETF", market: 1 },
    { code: "159992", name: "创新药ETF", market: 0 },
    { code: "512480", name: "半导体ETF", market: 1 },
    { code: "516160", name: "新能源车ETF", market: 1 },
    { code: "513030", name: "德国DAX ETF", market: 1 },
  ]
};

// --- 工具类 ---
class TechnicalIndicators {
  static sma = (values: number[], period: number): (number | null)[] => {
    const result: (number | null)[] = Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result[i] = sum / period;
    }
    return result;
  };

  static rsi = (values: number[], period = 14): (number | null)[] => {
    const result: (number | null)[] = Array(values.length).fill(null);
    let gains: number[] = [];
    let losses: number[] = [];

    for (let i = 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      gains.push(Math.max(change, 0));
      losses.push(Math.max(-change, 0));
    }
    
    if (gains.length < period) return result;

    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    result[period] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));

    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result[i+1] = 100 - (100 / (1 + rs));
    }
    return result;
  };

  static percentileRank = (values: number[], window = 252): (number | null)[] => {
    const result: (number | null)[] = Array(values.length).fill(null);
    for (let i = window - 1; i < values.length; i++) {
      const slice = values.slice(i - window + 1, i + 1);
      const currentValue = values[i];
      const count = slice.filter(v => v < currentValue).length;
      result[i] = count / slice.length;
    }
    return result;
  };

  static maxDrawdown = (values: number[], window = 252): (number | null)[] => {
    const result: (number | null)[] = Array(values.length).fill(null);
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = values.slice(start, i + 1);
      const peak = Math.max(...slice);
      result[i] = peak > 0 ? (peak - values[i]) / peak : 0;
    }
    return result;
  };
}

class DataFetcher {
static getEastMoneyUrl = (secid: string, limit = 300) => {
  const baseUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60&klt=101&fqt=1&end=20991231&lmt=${limit}`;
  // 我们把 allorigins.win 换成了 corsproxy.io
  return `https://corsproxy.io/?${encodeURIComponent(baseUrl)}`;
};

  async fetchSingleETF(item: { market: number; code: string; }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const secid = `${item.market}.${item.code}`;
      const url = DataFetcher.getEastMoneyUrl(secid);
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const data = await response.json();
      if (!data?.data?.klines) throw new Error('Invalid data format');

      const klines = data.data.klines.map((line: string) => {
        const [date, , close] = line.split(",");
        return { date: new Date(date), close: parseFloat(close) };
      }).filter((d: { date: Date, close: number }) => !isNaN(d.close));

      return klines.sort((a: { date: Date }, b: { date: Date }) => a.date.getTime() - b.date.getTime());
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchAllData(watchlist: any[]) {
    const promises = watchlist.map(item => this.fetchSingleETF(item));
    const results = await Promise.allSettled(promises);
    
    const dataMap: any = {};
    const errors: any[] = [];

    results.forEach((result, index) => {
      const item = watchlist[index];
      if (result.status === 'fulfilled') {
        dataMap[item.code] = this.analyzeData(result.value);
      } else {
        errors.push({ code: item.code, name: item.name, error: result.reason.message });
      }
    });

    return { dataMap, errors };
  }
  
  analyzeData(rawData: any[]) {
    if (!rawData || rawData.length < 50) return null;

    const closes = rawData.map(d => d.close);
    const enrichedData = rawData.map((item, i) => ({
      ...item,
      sma20: TechnicalIndicators.sma(closes, 20)[i],
      rsi14: TechnicalIndicators.rsi(closes, 14)[i],
      percentile: TechnicalIndicators.percentileRank(closes, 252)[i],
      drawdown: TechnicalIndicators.maxDrawdown(closes, 252)[i],
    }));

    const latest = enrichedData[enrichedData.length - 1];
    
    return { data: enrichedData, latest, signals: this.generateSignals(latest) };
  }

  generateSignals(latest: any) {
    let score = 0;
    const reasons: string[] = [];

    if (latest.rsi14 !== null) {
      if (latest.rsi14 <= 30) { score += 2; reasons.push(`RSI超卖(${latest.rsi14.toFixed(1)})`); }
      else if (latest.rsi14 <= 40) { score += 1; reasons.push(`RSI偏低(${latest.rsi14.toFixed(1)})`); }
    }
    if (latest.percentile !== null) {
      if (latest.percentile <= 0.1) { score += 3; reasons.push(`极低分位(${(latest.percentile * 100).toFixed(0)}%)`); }
      else if (latest.percentile <= 0.2) { score += 2; reasons.push(`低分位(${(latest.percentile * 100).toFixed(0)}%)`); }
    }
    if (latest.drawdown !== null && latest.drawdown >= 0.3) {
      score += 2; reasons.push(`高回撤(${(latest.drawdown * 100).toFixed(1)}%)`);
    }

    let action = "⚪ 观望等待";
    if (score >= 5) {
        action = "🔴 重点关注";
    } else if (score >= 3) {
        action = "🟠 积极定投";
    } else if (score >= 1) {
        action = "🟡 常规定投";
    }
    
    return { score, action, reasons };
  }
}

// --- 子组件 ---
const StatCard = ({ icon, label, value }: { icon: React.ReactNode, label: string, value: string | number }) => (
  <div className="flex items-center space-x-2">
    <div className="p-2 bg-blue-100 rounded-full">{icon}</div>
    <div>
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`font-bold text-gray-800`}>{value}</div>
    </div>
  </div>
);

const SkeletonCard = () => (
    <Card className="shadow-lg">
        <CardHeader>
            <CardTitle className="h-6 bg-gray-200 rounded w-3/4 animate-pulse"></CardTitle>
        </CardHeader>
        <CardContent className="p-6">
            <div className="space-y-4">
                <div className="h-24 bg-gray-100 rounded animate-pulse"></div>
                <div className="h-64 bg-gray-100 rounded animate-pulse"></div>
            </div>
        </CardContent>
    </Card>
);

// --- 主组件 ---
export default function ETFMonitorEnhanced() {
  const [dataMap, setDataMap] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<any[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  const dataFetcher = useMemo(() => new DataFetcher(), []);

  const loadRealData = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    const { dataMap: results, errors: fetchErrors } = await dataFetcher.fetchAllData(CONFIG.watchlist);
    setDataMap(results);
    setErrors(fetchErrors);
    setLastUpdate(new Date());
    setLoading(false);
  }, [dataFetcher]);

  useEffect(() => {
    loadRealData();
  }, [loadRealData]);

  const sortedItems = useMemo(() => {
    return CONFIG.watchlist
      .map(item => ({ ...item, analysis: dataMap[item.code] }))
      .filter(item => item.analysis)
      .sort((a, b) => (b.analysis.signals.score || 0) - (a.analysis.signals.score || 0));
  }, [dataMap]);
  
  const weeklyPick = useMemo(() => sortedItems.find(item => item.analysis.signals.score >= 3) || null, [sortedItems]);

  const getSignalStyle = (score: number) => {
    if (score >= 5) return { bg: 'bg-red-50', border: 'border-red-500', text: 'text-red-700' };
    if (score >= 3) return { bg: 'bg-orange-50', border: 'border-orange-500', text: 'text-orange-700' };
    if (score >= 1) return { bg: 'bg-yellow-50', border: 'border-yellow-500', text: 'text-yellow-700' };
    return { bg: 'bg-gray-50', border: 'border-gray-300', text: 'text-gray-700' };
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800">ETF 智能定投助手</h1>
          <p className="text-gray-500 mt-2">数据驱动决策，轻松把握投资时机</p>
          <div className="flex justify-center gap-4 mt-6">
            <Button onClick={loadRealData} disabled={loading} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 shadow-sm">
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              {loading ? '刷新中...' : '刷新数据'}
            </Button>
          </div>
        </header>

        <AnimatePresence>
          {errors.length > 0 && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <Card className="bg-red-50 border-red-200">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-red-700 mb-2">
                    <AlertTriangle className="h-5 w-5" />
                    <h3 className="font-semibold">数据获取异常 ({errors.length}个)</h3>
                  </div>
                  {errors.slice(0, 3).map((err) => (
                    <div key={err.code} className="text-sm text-red-600 ml-7">• {err.name} ({err.code}): {err.error}</div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Target className="h-5 w-5 text-blue-600" />定投建议排行</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {loading ? [...Array(6)].map((_, i) => (
                      <div key={i} className="p-3 rounded-lg bg-gray-50 animate-pulse">
                          <div className="h-5 bg-gray-200 rounded w-3/4 mb-2"></div>
                          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                      </div>
                  )) : sortedItems.map((item, idx) => {
                      const style = getSignalStyle(item.analysis.signals.score);
                      return(
                      <motion.div key={item.code} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 * idx }}>
                          <div className={`p-3 rounded-lg border-l-4 ${style.bg} ${style.border}`}>
                              <div className="flex justify-between items-center">
                                  <div>
                                      <p className="font-semibold text-gray-800">{item.name}</p>
                                      <p className={`text-sm font-medium ${style.text}`}>{item.analysis.signals.action}</p>
                                  </div>
                                  <div className="text-right">
                                      <p className="font-bold text-lg text-gray-900">¥{item.analysis.latest.close.toFixed(3)}</p>
                                      <p className="text-xs text-gray-500">评分: {item.analysis.signals.score}</p>
                                  </div>
                              </div>
                          </div>
                      </motion.div>
                  )})}
                </div>
              </CardContent>
            </Card>
          </div>
          
          <div className="lg:col-span-2">
            {loading ? <SkeletonCard /> : (
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Star className="h-5 w-5 text-amber-500" />本周重点关注</CardTitle>
              </CardHeader>
              <CardContent className="p-6">
              {weeklyPick ? (
                <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200">
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <h3 className="text-2xl font-bold text-gray-800">{weeklyPick.name} ({weeklyPick.code})</h3>
                                <p className="text-gray-600">{weeklyPick.analysis.signals.reasons.join(' / ')}</p>
                            </div>
                            <div className="bg-green-100 text-green-800 text-xs font-bold px-3 py-1 rounded-full">高价值区</div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
                            <StatCard icon={<TrendingDown className="h-5 w-5 text-blue-600"/>} label="RSI(14)" value={weeklyPick.analysis.latest.rsi14?.toFixed(1) || '-'} />
                            <StatCard icon={<Percent className="h-5 w-5 text-blue-600"/>} label="估值分位" value={weeklyPick.analysis.latest.percentile ? `${(weeklyPick.analysis.latest.percentile * 100).toFixed(0)}%` : '-'} />
                            <StatCard icon={<ArrowDownWideNarrow className="h-5 w-5 text-blue-600"/>} label="最大回撤" value={weeklyPick.analysis.latest.drawdown ? `${(weeklyPick.analysis.latest.drawdown * 100).toFixed(1)}%` : '-'} />
                            <StatCard icon={<LineChartIcon className="h-5 w-5 text-blue-600"/>} label="当前价格" value={`¥${weeklyPick.analysis.latest.close.toFixed(3)}`} />
                        </div>
                    </div>
                  
                  <div className="h-64 mt-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={weeklyPick.analysis.data.slice(-60).map((d: any) => ({ date: d.date.toLocaleDateString('zh-CN', {month:'2-digit', day:'2-digit'}), price: d.close, sma20: d.sma20 }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                        <YAxis domain={['dataMin * 0.98', 'dataMax * 1.02']} tick={{ fontSize: 10 }} tickFormatter={(val) => `¥${Number(val).toFixed(2)}`} />
                        <Tooltip contentStyle={{backgroundColor: 'rgba(255, 255, 255, 0.8)', borderRadius: '0.5rem', backdropFilter: 'blur(5px)'}} />
                        <Legend />
                        <Line type="monotone" dataKey="price" stroke="#2563eb" strokeWidth={2} dot={false} name="价格" />
                        <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeDasharray="5 5" dot={false} name="20日均线" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : (
                <div className="text-center py-16 text-gray-500">
                  <CalendarDays className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>当前无明确的高分推荐标的</p>
                  <p className="text-xs mt-1">建议保持定投或等待更佳时机</p>
                </div>
              )}
            </CardContent>
            </Card>
            )}
          </div>
        </div>

        <footer className="bg-white p-4 rounded-lg text-center text-sm text-gray-500 shadow-sm">
            <div className="flex flex-wrap justify-center items-center gap-x-4 gap-y-2">
                <span>数据源: 东方财富</span>
                <span>•</span>
                <span>最后更新: {lastUpdate ? lastUpdate.toLocaleString('zh-CN') : '加载中...'}</span>
                <span className="text-red-500 font-semibold">⚠️ 市场有风险，投资需谨慎。本工具仅为数据分析参考。</span>
            </div>
        </footer>
      </div>
    </div>
  );
}