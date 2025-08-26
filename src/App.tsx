import StickyNotesZoomDemo from './StickyNotesZoomDemo'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm p-4">
        <h1 className="text-2xl font-bold text-gray-800">Canvas Kozaneba</h1>
        <p className="text-gray-600">高性能付箋システム - 10,000枚の付箋を滑らかに操作</p>
      </header>
      <main className="p-4">
        <StickyNotesZoomDemo />
      </main>
    </div>
  )
}

export default App