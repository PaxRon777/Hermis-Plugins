/**
 * Obsidian Vault Search Plugin
 *
 * Features:
 * - Search vault by filename and content
 * - Side panel showing search results with metadata
 * - Open notes in Hermes preview pane
 * - Copy file paths (full and relative)
 * - Display file content in the plugin pane
 * - Configurable vault path (persisted in plugin storage)
 */
import { Button, Input, Select, SelectTrigger, SelectContent, SelectItem, SelectValue, Tip, cn, haptic, host, usePluginI18n, useValue, Codicon, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from '@hermes/plugin-sdk'
import { useState, useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'obsidian-vault-search'
const DEFAULT_VAULT_PATH = 'C:\\Users\\paulm\\OneDrive\\AI\\KnowledgeBase'

// ─── Settings Dialog ─────────────────────────────────────────────────────────
function SettingsDialog({ isOpen, onClose, ctx }) {
  const t = usePluginI18n(ID)
  const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT_PATH)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testPassed, setTestPassed] = useState(false)

  // Load saved path when dialog opens
  const loadPath = async () => {
    const saved = await ctx.storage.get('vaultPath')
    if (saved) setVaultPath(saved)
  }

  // Call loadPath when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadPath()
    }
  }, [isOpen])

  // Reset test state when path changes
  const handlePathChange = (e) => {
    setVaultPath(e.target.value)
    setTestResult(null)
    setTestPassed(false)
  }

  const savePath = async () => {
    await ctx.storage.set('vaultPath', vaultPath)
    host.notify({ kind: 'success', message: t('settingsSaved') })
    onClose()
  }

  const testPath = async () => {
    setTesting(true)
    setTestResult(null)
    setTestPassed(false)
    try {
      // Test the exact path in the input field (don't fall back)
      const pathToTest = vaultPath.trim()
      if (!pathToTest) {
        setTestResult({ success: false, message: t('testNotFound') })
        setTesting(false)
        return
      }

      // The Hermes plugin SDK's `ctx.rest` does not support query-string
      // params on GET, so POST the path in the body to the matching
      // `POST /info` endpoint on the backend.
      const result = await ctx.rest('/info', {
        method: 'POST',
        body: { vault_path: pathToTest }
      })
      if (result.exists) {
        setTestResult({ success: true, message: t('testSuccess').replace('{0}', String(result.total_notes)) })
        setTestPassed(true)
      } else if (result.reason === 'not_an_obsidian_vault') {
        setTestResult({ success: false, message: t('testNotVault') })
      } else {
        setTestResult({ success: false, message: t('testNotFound') })
      }
    } catch (err) {
      setTestResult({ success: false, message: t('testError').replace('{0}', err.message) })
    } finally {
      setTesting(false)
    }
  }

  return jsx(Dialog, {
    open: isOpen,
    onOpenChange: (open) => { if (!open) onClose() },
    children: jsxs(DialogContent, {
      className: 'max-w-md',
      children: [
        jsx(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: t('settingsTitle') }),
            jsx(DialogDescription, { children: t('settingsDesc') })
          ]
        }),
        jsxs('div', {
          className: 'space-y-4',
          children: [
            jsxs('div', {
              className: 'space-y-2',
              children: [
                jsx('label', { className: 'text-sm font-medium', children: t('vaultPathLabel') }),
                jsx(Input, {
                  value: vaultPath,
                  onChange: handlePathChange,
                  placeholder: t('vaultPathPlaceholder'),
                  className: 'font-mono text-xs'
                }),
                jsxs('div', {
                  className: 'flex gap-2',
                  children: [
                    jsx(Button, {
                      onClick: testPath,
                      disabled: testing,
                      variant: 'outline',
                      size: 'sm',
                      children: testing ? t('testing') : t('testPath')
                    }),
                    testResult && jsx('span', {
                      className: cn('text-xs flex-1', { color: testResult.success ? 'var(--ui-accent)' : 'var(--ui-destructive)' }),
                      children: testResult.message
                    })
                  ]
                })
              ]
            }),
            jsx('p', {
              className: cn('text-xs', { color: 'var(--ui-text-quaternary)' }),
              children: t('settingsNote')
            })
          ]
        }),
        jsx(DialogFooter, {
          children: [
            jsx(Button, {
              variant: 'ghost',
              onClick: onClose,
              children: t('cancel')
            }),
            jsx(Button, {
              onClick: savePath,
              disabled: !testPassed,
              children: t('save')
            })
          ]
        })
      ]
    })
  })
}

// ─── Search Pane Component ──────────────────────────────────────────────────
function VaultSearchPane({ ctx }) {
  const t = usePluginI18n(ID)
  const gateway = useValue(host.state.gateway)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [searchType, setSearchType] = useState('all') // 'all' | 'files' | 'content'
  const [selectedFile, setSelectedFile] = useState(null)
  const [showSettings, setShowSettings] = useState(false)

  const handleSearch = async () => {
    if (!query.trim()) return
    haptic('tap')
    setLoading(true)
    try {
      const savedVaultPath = await ctx.storage.get('vaultPath')
      const data = await ctx.rest('/search', {
        method: 'POST',
        body: { query: query.trim(), limit: 20, search_type: searchType, vault_path: savedVaultPath || DEFAULT_VAULT_PATH }
      })
      setResults(data)
      setSelectedFile(null)
      host.notify({ kind: 'success', message: `Found ${(data.files?.length || 0) + (data.content?.length || 0)} results` })
    } catch (err) {
      host.notify({ kind: 'error', message: 'Search failed: ' + err.message })
    } finally {
      setLoading(false)
    }
  }

  const handleOpenFile = async (filePath) => {
    haptic('tap')
    try {
      const savedVaultPath = await ctx.storage.get('vaultPath')
      const vaultRoot = savedVaultPath || DEFAULT_VAULT_PATH
      // Compute vault-relative path client-side so the "copy relative path"
      // button works in the file viewer too. Normalize separators.
      let relPath = filePath
      const normalizedFile = filePath.replace(/\\/g, '/')
      const normalizedVault = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '')
      if (normalizedFile.toLowerCase().startsWith(normalizedVault.toLowerCase() + '/')) {
        relPath = normalizedFile.slice(normalizedVault.length + 1)
      }
      const data = await ctx.rest('/read', {
        method: 'POST',
        body: { file_path: filePath, vault_path: vaultRoot }
      })
      setSelectedFile({ path: filePath, rel_path: relPath, content: data.content || data.error || 'No content' })
    } catch (err) {
      host.notify({ kind: 'error', message: 'Failed to read file: ' + err.message })
    }
  }

  const handleCopyPath = (path) => {
    navigator.clipboard.writeText(path)
    host.notify({ kind: 'success', message: 'Copied full path' })
  }

  const handleCopyRelPath = (relPath) => {
    navigator.clipboard.writeText(relPath)
    host.notify({ kind: 'success', message: 'Copied relative path' })
  }

  const renderCopyButtons = (filePath, relPath) => jsxs('div', {
    className: 'flex gap-1',
    children: [
      jsx(Button, {
        onClick: (e) => { e.stopPropagation(); handleCopyPath(filePath) },
        variant: 'ghost',
        size: 'icon-xs',
        children: jsx(Codicon, { name: 'copy', size: '0.75rem' })
      }),
      jsx(Button, {
        onClick: (e) => { e.stopPropagation(); handleCopyRelPath(relPath) },
        variant: 'ghost',
        size: 'icon-xs',
        children: jsx(Codicon, { name: 'link-external', size: '0.75rem' })
      })
    ]
  })

  return jsxs('div', {
    className: cn('flex h-full flex-col', { background: 'var(--ui-background)' }),
    children: [
      // Header with search
      jsxs('div', {
        className: cn('p-3 border-b', { borderColor: 'var(--ui-stroke-secondary)' }),
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between mb-2',
            children: [
              jsx('div', {
                className: cn('text-sm font-medium', { color: 'var(--ui-text-primary)' }),
                children: t('paneTitle')
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-sm',
                onClick: () => setShowSettings(true),
                children: jsx(Codicon, { name: 'gear', size: '1rem' })
              })
            ]
          }),
          jsxs('div', {
            className: 'flex gap-2 mb-2',
            children: [
              jsx(Select, {
                value: searchType,
                onValueChange: setSearchType,
                className: 'w-full',
                children: [
                  jsx(SelectTrigger, {
                    className: 'w-full',
                    children: [jsx(SelectValue, { placeholder: 'Search type' })]
                  }),
                  jsx(SelectContent, {
                    children: [
                      jsx(SelectItem, { value: 'all', children: 'All (files + content)' }),
                      jsx(SelectItem, { value: 'files', children: 'Filenames only' }),
                      jsx(SelectItem, { value: 'content', children: 'Content only' }),
                    ]
                  })
                ]
              }),
            ]
          }),
          jsxs('div', {
            className: 'flex gap-2',
            children: [
              jsx(Input, {
                type: 'text',
                value: query,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => e.key === 'Enter' && handleSearch(),
                placeholder: 'Search vault by filename or content...',
                className: 'flex-1'
              }),
              jsx(Button, {
                onClick: handleSearch,
                disabled: loading || !query.trim(),
                variant: 'default',
                children: loading ? 'Searching...' : 'Search'
              })
            ]
          })
        ]
      }),

      // Results area
      jsx('div', {
        className: 'flex-1 overflow-y-auto p-3',
        children: selectedFile ? (
          jsxs('div', {
            className: 'flex h-full flex-col',
            children: [
              jsxs('div', {
                className: cn('p-3 border-b flex items-center justify-between', { borderColor: 'var(--ui-stroke-secondary)' }),
                children: [
                  jsx('div', {
                    className: cn('flex-1 font-medium truncate text-left', { color: 'var(--ui-text-primary)' }),
                    children: selectedFile.path.split('\\').pop() || selectedFile.path.split('/').pop()
                  }),
                  renderCopyButtons(selectedFile.path, selectedFile.rel_path || selectedFile.path),
                  jsx(Button, {
                    onClick: () => setSelectedFile(null),
                    variant: 'ghost',
                    size: 'sm',
                    children: '\u2190 Back to results'
                  })
                ]
              }),
              jsx('div', {
                className: cn('flex-1 overflow-y-auto p-3 font-mono text-sm whitespace-pre-wrap', { color: 'var(--ui-text-secondary)' }),
                children: selectedFile.content
              })
            ]
          })
        ) : results ? (
          jsxs('div', {
            children: [
              (results.files?.length || results.content?.length) > 0 ? (
                jsxs('div', {
                  children: [
                    results.files?.length > 0 && jsxs('div', {
                      className: 'mb-4',
                      children: [
                        jsx('div', { className: cn('text-xs font-medium uppercase tracking-wider mb-2', { color: 'var(--ui-text-tertiary)' }), children: `Files (${results.files.length})` }),
                        jsx('div', {
                          className: 'space-y-1 max-h-60 overflow-y-auto',
                          children: results.files.map((file, i) => jsxs('div', {
                            className: cn('border rounded-md overflow-hidden', { borderColor: 'var(--ui-stroke-secondary)' }),
                            children: [
                              jsx(Button, {
                                onClick: () => handleOpenFile(file.path),
                                variant: 'ghost',
                                className: 'w-full text-left p-2 rounded-t-md border-b justify-start',
                                style: { borderColor: 'var(--ui-stroke-secondary)' },
                                children: jsxs('div', {
                                  className: 'flex flex-col gap-0.5 min-w-0',
                                  children: [
                                    jsx('div', { className: cn('font-medium truncate', { color: 'var(--ui-text-primary)' }), children: file.name }),
                                    file.folder && jsx('div', { className: cn('text-xs truncate', { color: 'var(--ui-text-quaternary)' }), children: file.folder + '/' })
                                  ]
                                })
                              }),
                              jsxs('div', {
                                className: 'flex items-center justify-between px-2 py-1.5',
                                style: { backgroundColor: 'var(--ui-background-elevated)' },
                                children: [
                                  jsx('div', { className: 'flex-1 min-w-0' }),
                                  renderCopyButtons(file.path, file.rel_path)
                                ]
                              })
                            ]
                          }, i))
                        })
                      ]
                    }),
                    results.content?.length > 0 && jsxs('div', {
                      children: [
                        jsx('div', { className: cn('text-xs font-medium uppercase tracking-wider mb-2', { color: 'var(--ui-text-tertiary)' }), children: `Content Matches (${results.content.length})` }),
                        jsx('div', {
                          className: 'space-y-1 max-h-60 overflow-y-auto',
                          children: results.content.map((match, i) => jsxs('div', {
                            className: cn('border rounded-md overflow-hidden', { borderColor: 'var(--ui-stroke-secondary)' }),
                            children: [
                              jsx(Button, {
                                onClick: () => handleOpenFile(match.path),
                                variant: 'ghost',
                                className: 'w-full text-left p-2 rounded-t-md border-b justify-start',
                                style: { borderColor: 'var(--ui-stroke-secondary)' },
                                children: jsxs('div', {
                                  className: 'flex flex-col gap-0.5 min-w-0',
                                  children: [
                                    jsxs('div', { className: 'flex items-center justify-between min-w-0', children: [
                                      jsx('span', { className: cn('font-medium truncate', { color: 'var(--ui-text-primary)' }), children: match.name }),
                                      jsx('span', { className: cn('text-xs shrink-0 ml-2', { color: 'var(--ui-text-quaternary)' }), children: `L${match.line_number}` })
                                    ]}),
                                    jsx('div', { className: cn('text-xs truncate', { color: 'var(--ui-text-quaternary)' }), children: match.context_line }),
                                    match.folder && jsx('div', { className: cn('text-xs truncate', { color: 'var(--ui-text-quaternary)' }), children: match.folder + '/' })
                                  ]
                                })
                              }),
                              jsxs('div', {
                                className: 'flex items-center justify-between px-2 py-1.5',
                                style: { backgroundColor: 'var(--ui-background-elevated)' },
                                children: [
                                  jsx('div', { className: 'flex-1 min-w-0' }),
                                  renderCopyButtons(match.path, match.rel_path)
                                ]
                              })
                            ]
                          }, i))
                        })
                      ]
                    })
                  ]
                })
              ) : (
                jsx('div', {
                  className: 'flex items-center justify-center h-full',
                  children: jsx('div', {
                    className: 'text-center',
                    children: jsx('div', { className: cn('text-sm', { color: 'var(--ui-text-quaternary)' }), children: 'No results found' })
                  })
                })
              )
            ]
          })
        ) : (
          jsx('div', {
            className: 'flex items-center justify-center h-full',
            children: jsx('div', {
              className: 'text-center',
              children: jsx('div', { className: cn('text-sm', { color: 'var(--ui-text-quaternary)' }), children: t('searchHint') })
            })
          })
        )
      }),

      // Settings Dialog
      jsx(SettingsDialog, {
        isOpen: showSettings,
        onClose: () => setShowSettings(false),
        ctx: ctx
      })
    ]
  })
}

// ─── Statusbar chip ─────────────────────────────────────────────────────────
function VaultChip() {
  const t = usePluginI18n(ID)

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx(Button, {
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: t('chipMessage') })
      },
      children: '\uD83D\uDCDA Vault'
    })
  })
}

// ─── Plugin registration ────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'Obsidian Vault Search',
  defaultEnabled: true,

  register(ctx) {
    // Register locale bundles
    ctx.i18n.register({
      en: {
        paneTitle: 'Vault Search',
        searchPlaceholder: 'Search vault by filename or content...',
        searchButton: 'Search',
        searchHint: 'Type to search your Obsidian vault',
        chipTip: 'Obsidian Vault Search \u2014 click for info',
        chipMessage: 'Search your vault, open notes in preview, and insert folder structure into prompts.',
        settingsTitle: 'Vault Settings',
        settingsDesc: 'Configure the path to your Obsidian vault.',
        vaultPathLabel: 'Vault Path',
        vaultPathPlaceholder: 'C:\\Users\\you\\Documents\\ObsidianVault',
        testPath: 'Test Path',
        testing: 'Testing...',
        testSuccess: 'Found {0} notes',
        testNotFound: 'Vault not found at this path',
        testNotVault: 'Not an Obsidian vault — missing .obsidian folder',
        testError: 'Error: {0}',
        settingsSaved: 'Settings saved. Changes take effect after restart.',
        settingsNote: 'Changes take effect after restart. The path is stored per-profile.',
        cancel: 'Cancel',
        save: 'Save',
        searchHint: 'Type to search your Obsidian vault'
      }
    })

    // Register settings command
    ctx.register({
      id: 'open-settings',
      area: 'PALETTE_AREA',
      title: 'Obsidian Vault Search: Settings',
      data: { category: 'Obsidian Vault Search' },
      onSelect: () => {
        // The pane will handle opening settings via its internal state
        // We can trigger via a custom event or just rely on the gear icon
      }
    })

    // Register side panel
    ctx.register({
      id: 'vault-pane',
      area: 'panes',
      title: 'Vault Search',
      data: { placement: 'right', width: '400px' },
      render: () => jsx(VaultSearchPane, { ctx })
    })

    // Register statusbar chip
    ctx.register({
      id: 'vault-chip',
      area: 'statusBar.right',
      order: 140,
      render: () => jsx(VaultChip, {})
    })
  }
}