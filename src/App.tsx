import StickyNotesZoomDemo from './StickyNotesZoomDemo'
import StickyNotesSelectDemo from './StickyNotesSelectDemo'
import StickyNotesClustersView from './StickyNotesClustersView'
import { useEffect, useState } from 'react'

function App() {
  // 依存ライブラリなしの超軽量ルーティング
  // 既存: "/" はそのまま StickyNotesZoomDemo
  // 追加: "/select" または "#/select" で StickyNotesSelectDemo
  // 追加: "/clusters" または "#/clusters" で クラスタ抽出+要約ビュー
  const getPath = () => {
    if (typeof window === 'undefined') return '/'
    const hash = window.location.hash
    if (hash && hash.startsWith('#/')) return hash.slice(1)
    return window.location.pathname || '/'
  }

  const [path, setPath] = useState(getPath())
  useEffect(() => {
    const onChange = () => setPath(getPath())
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [])

  if (path === '/select') return <StickyNotesSelectDemo />
  if (path === '/clusters') return <StickyNotesClustersView />
  return <StickyNotesZoomDemo />
}

export default App
