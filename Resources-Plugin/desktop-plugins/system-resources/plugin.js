/**
 * System Resources Monitor Plugin - Hermes Desktop Plugin
 *
 * Real-time monitoring of:
 * - CPU (total + per-core)
 * - RAM (system + swap)
 * - GPU (utilization, VRAM, temperature, power)
 *
 * Uses @hermes/plugin-sdk design system components + CSS variables only.
 * Polls Python backend at /api/plugins/system-resources/resources every 2s.
 */

import {
  Button,
  cn,
  haptic,
  host,
  Tip,
  usePluginI18n,
  Codicon,
  ScrollArea,
  Badge,
} from '@hermes/plugin-sdk'
import { useState, useEffect, useRef, useMemo } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'system-resources'
const UPDATE_INTERVAL = 2000 // 2 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function getUsageColor(percent) {
  if (percent >= 90) return 'var(--ui-destructive)'
  if (percent >= 70) return 'var(--ui-warning, var(--ui-accent))'
  return 'var(--ui-accent)'
}

// ─── Custom Progress Bar (Progress component not in SDK) ─────────────────────
function ProgressBar({ value, color }) {
  const pct = Math.min(Math.max(value, 0), 100)
  return jsx('div', {
    className: 'h-1.5 w-full overflow-hidden rounded-full',
    style: { backgroundColor: 'var(--ui-stroke-tertiary, var(--ui-stroke-secondary))' },
    children: jsx('div', {
      className: 'h-full rounded-full transition-all duration-300 ease-out',
      style: {
        width: `${pct}%`,
        backgroundColor: color || getUsageColor(pct),
      }
    })
  })
}

// ─── SVG Sparkline ──────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 48 }) {
  if (!data || data.length < 2) {
    return jsx('div', { style: { height }, className: 'w-full' })
  }

  const maxVal = Math.max(...data, 1)
  const minVal = Math.min(...data, 0)
  const range = maxVal - minVal || 1
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * 100
    const y = 100 - ((val - minVal) / range) * 90 - 5  // 5% padding top/bottom
    return `${x},${y}`
  }).join(' ')
  const fillPoints = `0,100 ${points} 100,100`

  return jsxs('svg', {
    viewBox: '0 0 100 100',
    preserveAspectRatio: 'none',
    style: { height, width: '100%', overflow: 'visible' },
    className: 'select-none',
    children: [
      jsx('defs', {
        children: jsx('linearGradient', {
          id: 'spark-grad',
          x1: '0', y1: '0',
          x2: '0', y2: '1',
          children: [
            jsx('stop', { offset: '0%', stopColor: color, stopOpacity: '0.4' }),
            jsx('stop', { offset: '100%', stopColor: color, stopOpacity: '0' })
          ]
        })
      }),
      jsx('polygon', { points: fillPoints, fill: 'url(#spark-grad)' }),
      jsx('polyline', {
        fill: 'none',
        stroke: color,
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        points,
        style: { filter: `drop-shadow(0 0 2px ${color})` }
      })
    ]
  })
}

// ─── Metric Card ────────────────────────────────────────────────────────────
function MetricCard({ label, value, unit, percent, history, color, icon }) {
  const usageColor = color || getUsageColor(percent || 0)

  return jsxs('div', {
    className: 'group p-3 rounded-lg border transition-all',
    style: {
      borderColor: 'var(--ui-stroke-secondary)',
      backgroundColor: 'var(--ui-background-elevated, var(--ui-background))'
    },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 mb-2',
        children: [
          icon && jsx(Codicon, { name: icon, size: '0.875rem', className: 'shrink-0', style: { color: 'var(--ui-text-tertiary)' } }),
          jsx('span', {
            className: 'text-xs font-medium uppercase tracking-wider',
            style: { color: 'var(--ui-text-tertiary)' },
            children: label
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-baseline gap-1 mb-2',
        children: [
          jsx('span', {
            className: 'text-2xl font-mono font-semibold leading-none',
            style: { color: usageColor },
            children: value
          }),
          unit && jsx('span', {
            className: 'text-xs font-mono',
            style: { color: 'var(--ui-text-quaternary)' },
            children: unit
          })
        ]
      }),
      history && history.length > 1 && jsx('div', {
        className: 'w-full mb-2',
        children: jsx(Sparkline, { data: history, color: usageColor, height: 40 })
      }),
      percent !== undefined && jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(ProgressBar, { value: percent, color: usageColor }),
          jsx('span', {
            className: 'text-xs font-mono shrink-0 w-9 text-right',
            style: { color: 'var(--ui-text-quaternary)' },
            children: `${Math.round(percent)}%`
          })
        ]
      })
    ]
  })
}

// ─── CPU Details ────────────────────────────────────────────────────────────
function CPUDetails({ cpuData }) {
  const { total, cores, history } = cpuData || {}

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      MetricCard({
        label: 'Total CPU',
        value: total != null ? total.toFixed(1) : '--',
        unit: '%',
        percent: total ?? 0,
        history: history || [],
        icon: 'cpu'
      }),
      cores && cores.length > 0 && jsxs('div', {
        className: 'p-3 rounded-lg border',
        style: {
          borderColor: 'var(--ui-stroke-secondary)',
          backgroundColor: 'var(--ui-background-elevated, var(--ui-background))'
        },
        children: [
          jsx('div', {
            className: 'text-xs font-medium uppercase tracking-wider mb-3',
            style: { color: 'var(--ui-text-tertiary)' },
            children: `CPU Cores (${cores.length})`
          }),
          jsx('div', {
            className: 'grid gap-1.5',
            style: { gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))' },
            children: cores.map((core, i) => jsxs('div', {
              className: 'p-2 rounded text-center',
              style: {
                backgroundColor: 'var(--ui-background)',
                border: '1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary))'
              },
              children: [
                jsx('div', {
                  className: 'text-[0.625rem] mb-0.5',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: `Core ${i}`
                }),
                jsx('div', {
                  className: 'text-sm font-mono font-semibold',
                  style: { color: getUsageColor(core) },
                  children: `${core.toFixed(1)}%`
                })
              ]
            }, i))
          })
        ]
      })
    ]
  })
}

// ─── Memory Details ──────────────────────────────────────────────────────────
function MemoryDetails({ memData }) {
  const { used, total, percent, history, swap } = memData || {}

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      MetricCard({
        label: 'System RAM',
        value: formatBytes(used || 0),
        unit: `/ ${formatBytes(total || 0)}`,
        percent: percent ?? 0,
        history: history || [],
        icon: 'database'
      }),
      swap && MetricCard({
        label: 'Swap',
        value: formatBytes(swap.used || 0),
        unit: `/ ${formatBytes(swap.total || 0)}`,
        percent: swap.percent ?? 0,
        icon: 'database',
        color: getUsageColor(swap.percent ?? 0)
      })
    ]
  })
}

// ─── GPU Details ─────────────────────────────────────────────────────────────
function GPUDetails({ gpuData }) {
  if (!gpuData || !gpuData.length) {
    return jsx('div', {
      className: 'flex items-center justify-center h-32',
      children: jsx('div', {
        className: 'text-center',
        children: jsx('span', {
          className: 'text-sm',
          style: { color: 'var(--ui-text-quaternary)' },
          children: 'No GPU detected or access denied'
        })
      })
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: gpuData.map((gpu, idx) => jsxs('div', {
      className: 'p-3 rounded-lg border',
      style: {
        borderColor: 'var(--ui-stroke-secondary)',
        backgroundColor: 'var(--ui-background-elevated, var(--ui-background))'
      },
      children: [
        jsxs('div', {
          className: 'flex items-center justify-between mb-3',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-2 min-w-0',
              children: [
                jsx(Codicon, { name: 'gpu', size: '1rem', className: 'shrink-0', style: { color: 'var(--ui-text-tertiary)' } }),
                jsx('span', {
                  className: 'font-medium truncate',
                  style: { color: 'var(--ui-text-primary)' },
                  children: gpu.name || `GPU ${idx}`
                })
              ]
            }),
            gpu.temp != null && jsx(Badge, {
              variant: 'outline',
              className: 'shrink-0 font-mono',
              children: `${gpu.temp}°C`
            })
          ]
        }),
        jsxs('div', {
          className: 'grid gap-3',
          style: { gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' },
          children: [
            MetricCard({
              label: 'GPU Util',
              value: gpu.utilization != null ? gpu.utilization.toFixed(1) : '--',
              unit: '%',
              percent: gpu.utilization ?? 0,
              history: gpu.utilHistory || [],
              icon: 'pulse'
            }),
            MetricCard({
              label: 'VRAM',
              value: formatBytes(gpu.vramUsed || 0),
              unit: `/ ${formatBytes(gpu.vramTotal || 0)}`,
              percent: gpu.vramPercent ?? 0,
              icon: 'memory'
            }),
            gpu.powerDraw != null && MetricCard({
              label: 'Power',
              value: gpu.powerDraw.toFixed(1),
              unit: `W / ${gpu.powerLimit}W`,
              percent: gpu.powerLimit ? (gpu.powerDraw / gpu.powerLimit) * 100 : 0,
              icon: 'zap'
            })
          ].filter(Boolean)
        })
      ]
    }, idx))
  })
}

// ─── Overview Tab Content ───────────────────────────────────────────────────
// Just the four headline metrics in a 2×2 grid. Visit the dedicated tabs
// (CPU / Memory / GPU) for per-core breakdowns, swap, temperature, power, etc.
function OverviewContent({ resources }) {
  const { cpu, memory, gpu } = resources || {}

  return jsx(ScrollArea, {
    className: 'h-full',
    children: jsxs('div', {
      className: 'grid gap-3 p-3',
      style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
      children: [
        MetricCard({
          label: 'CPU',
          value: cpu?.total != null ? cpu.total.toFixed(1) : '--',
          unit: '%',
          percent: cpu?.total ?? 0,
          history: cpu?.history || [],
          icon: 'cpu'
        }),
        MetricCard({
          label: 'RAM',
          value: formatBytes(memory?.used || 0),
          unit: `/ ${formatBytes(memory?.total || 0)}`,
          percent: memory?.percent ?? 0,
          history: memory?.history || [],
          icon: 'database'
        }),
        gpu?.length ? MetricCard({
          label: 'GPU',
          value: gpu[0].utilization != null ? gpu[0].utilization.toFixed(1) : '--',
          unit: '%',
          percent: gpu[0].utilization ?? 0,
          history: gpu[0].utilHistory || [],
          icon: 'gpu'
        }) : MetricCard({ label: 'GPU', value: 'N/A', unit: '', percent: 0, icon: 'gpu' }),
        gpu?.length ? MetricCard({
          label: 'VRAM',
          value: formatBytes(gpu[0].vramUsed || 0),
          unit: `/ ${formatBytes(gpu[0].vramTotal || 0)}`,
          percent: gpu[0].vramPercent ?? 0,
          icon: 'memory'
        }) : MetricCard({ label: 'VRAM', value: 'N/A', unit: '', percent: 0, icon: 'memory' })
      ]
    })
  })
}

// ─── Main Pane ───────────────────────────────────────────────────────────────
function SystemResourcesPane({ ctx }) {
  const t = usePluginI18n(ID)
  const [resources, setResources] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [cycle, setCycle] = useState(0)  // force re-render for history
  const historyRef = useRef({ cpu: [], mem: [], gpu: [] })
  const intervalRef = useRef(null)

  const fetchResources = async () => {
    try {
      const data = await ctx.rest('/resources', { method: 'GET' })
      setResources(data)
      setLoading(false)

      // Update history (max 60 points)
      if (data.cpu?.total != null) {
        historyRef.current.cpu = [...historyRef.current.cpu.slice(-59), data.cpu.total]
      }
      if (data.memory?.percent != null) {
        historyRef.current.mem = [...historyRef.current.mem.slice(-59), data.memory.percent]
      }
      if (data.gpu?.length && data.gpu[0].utilization != null) {
        historyRef.current.gpu = [...historyRef.current.gpu.slice(-59), data.gpu[0].utilization]
      }
      setCycle(c => c + 1)
    } catch (err) {
      setLoading(false)
      console.error('System resources fetch failed:', err)
    }
  }

  useEffect(() => {
    fetchResources()
    intervalRef.current = setInterval(fetchResources, UPDATE_INTERVAL)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  // Merge history into resources
  const resourcesWithHistory = useMemo(() => {
    void cycle  // dependency to recompute on poll
    if (!resources) return null
    return {
      ...resources,
      cpu: { ...resources.cpu, history: historyRef.current.cpu },
      memory: { ...resources.memory, history: historyRef.current.mem },
      gpu: resources.gpu?.map(g => ({
        ...g,
        utilHistory: historyRef.current.gpu
      }))
    }
  }, [resources, cycle])

  if (loading) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center',
      children: jsx('span', {
        className: 'text-sm',
        style: { color: 'var(--ui-text-quaternary)' },
        children: 'Loading system resources...'
      })
    })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col',
    style: { backgroundColor: 'var(--ui-background)' },
    children: [
      // Header
      jsxs('div', {
        className: 'p-3 border-b',
        style: { borderColor: 'var(--ui-stroke-secondary)' },
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between mb-2',
            children: [
              jsx('span', {
                className: 'text-sm font-medium',
                style: { color: 'var(--ui-text-primary)' },
                children: t('paneTitle')
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: () => { haptic('tap'); fetchResources() },
                children: jsx(Codicon, { name: 'refresh', size: '0.875rem' })
              })
            ]
          }),
          // Custom tab buttons (Tabs/TabsContent not available in SDK)
          jsx('div', {
            className: 'grid w-full grid-cols-4 gap-1 p-1 rounded-lg',
            style: {
              backgroundColor: 'var(--ui-background-elevated, var(--ui-background))',
              border: '1px solid var(--ui-stroke-secondary)'
            },
            children: [
              { id: 'overview', label: 'Overview', icon: 'dashboard' },
              { id: 'cpu', label: 'CPU', icon: 'cpu' },
              { id: 'memory', label: 'Memory', icon: 'database' },
              { id: 'gpu', label: 'GPU', icon: 'gpu' }
            ].map(tab => jsx('button', {
              type: 'button',
              onClick: () => { haptic('tap'); setActiveTab(tab.id) },
              className: 'flex items-center justify-center gap-1.5 py-1.5 px-2 rounded text-xs font-medium transition-colors',
              style: {
                color: activeTab === tab.id ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
                backgroundColor: activeTab === tab.id ? 'var(--ui-background)' : 'transparent'
              },
              children: jsxs('span', {
                className: 'flex items-center gap-1.5',
                children: [
                  jsx(Codicon, { name: tab.icon, size: '0.75rem' }),
                  tab.label
                ]
              })
            }, tab.id))
          })
        ]
      }),

      // Tab content — siblings, not nested
      jsx('div', {
        className: 'flex-1 overflow-hidden',
        children: activeTab === 'overview'
          ? jsx(OverviewContent, { resources: resourcesWithHistory })
          : activeTab === 'cpu'
            ? jsx(ScrollArea, { className: 'h-full', children: jsx(CPUDetails, { cpuData: resourcesWithHistory?.cpu }) })
            : activeTab === 'memory'
              ? jsx(ScrollArea, { className: 'h-full', children: jsx(MemoryDetails, { memData: resourcesWithHistory?.memory }) })
              : jsx(ScrollArea, { className: 'h-full', children: jsx(GPUDetails, { gpuData: resourcesWithHistory?.gpu }) })
      })
    ]
  })
}

// ─── Statusbar Chip ─────────────────────────────────────────────────────────
function ResourcesChip() {
  const t = usePluginI18n(ID)
  const [summary, setSummary] = useState({ cpu: 0, mem: 0, gpu: 0, vram: 0 })
  const intervalRef = useRef(null)

  const fetchSummary = async () => {
    // The statusbar chip doesn't have ctx, so use fetch directly to the plugin REST endpoint
    try {
      const res = await fetch('/api/plugins/system-resources/summary')
      if (res.ok) {
        const data = await res.json()
        setSummary(data)
      }
    } catch (err) {
      // Backend may not be enabled — stay silent
    }
  }

  useEffect(() => {
    fetchSummary()
    intervalRef.current = setInterval(fetchSummary, 3000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const hasGpu = summary.gpu > 0 || summary.vram > 0

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx('button', {
      className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-mono transition-colors hover:bg-(--chrome-action-hover)',
      style: { color: 'var(--ui-text-tertiary)' },
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: t('chipMessage') })
      },
      children: [
        jsx(Codicon, { name: 'pulse', size: '0.75rem', style: { color: getUsageColor(summary.cpu) } }),
        jsx('span', { style: { color: getUsageColor(summary.cpu) }, children: `${Math.round(summary.cpu)}%` }),
        jsx('span', { style: { color: 'var(--ui-stroke-secondary)' }, children: '│' }),
        jsx(Codicon, { name: 'database', size: '0.75rem', style: { color: getUsageColor(summary.mem) } }),
        jsx('span', { style: { color: getUsageColor(summary.mem) }, children: `${Math.round(summary.mem)}%` }),
        hasGpu && jsxs('span', {
          className: 'inline-flex items-center gap-1',
          children: [
            jsx('span', { style: { color: 'var(--ui-stroke-secondary)' }, children: '│' }),
            jsx(Codicon, { name: 'gpu', size: '0.75rem', style: { color: getUsageColor(summary.gpu) } }),
            jsx('span', { style: { color: getUsageColor(summary.gpu) }, children: `${Math.round(summary.gpu)}%` }),
            jsx('span', { style: { color: 'var(--ui-stroke-secondary)' }, children: '│' }),
            jsx(Codicon, { name: 'memory', size: '0.75rem', style: { color: getUsageColor(summary.vram) } }),
            jsx('span', { style: { color: getUsageColor(summary.vram) }, children: `${Math.round(summary.vram)}%` })
          ]
        })
      ]
    })
  })
}

// ─── Plugin Registration ────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'System Resources Monitor',
  defaultEnabled: true,

  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'System Resources',
        chipTip: 'System Resources — CPU, RAM, GPU, VRAM',
        chipMessage: 'System Resources Monitor — CPU, RAM, GPU, and VRAM usage in real-time.'
      }
    })

    // Side panel
    ctx.register({
      id: 'resources-pane',
      area: 'panes',
      title: 'Resources',
      data: { placement: 'right', width: '340px' },
      render: () => jsx(SystemResourcesPane, { ctx })
    })

    // Statusbar chip
    ctx.register({
      id: 'resources-chip',
      area: 'statusBar.right',
      order: 150,
      render: () => jsx(ResourcesChip, {})
    })
  }
}