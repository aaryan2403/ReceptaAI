import lottie, { type AnimationItem } from 'lottie-web'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

type PreloadGateProps = {
  children: ReactNode
}

export default function PreloadGate({ children }: PreloadGateProps) {
  const [isDone, setIsDone] = useState(false)
  const [isExiting, setIsExiting] = useState(false)
  const animRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let isFinished = false
    const minVisibleMs = 1200
    const exitMs = 500
    const start = performance.now()

    const finish = () => {
      if (isFinished) return
      isFinished = true

      const elapsed = performance.now() - start
      const remaining = Math.max(0, minVisibleMs - elapsed)

      window.setTimeout(() => {
        setIsExiting(true)

        window.setTimeout(() => {
          setIsDone(true)
        }, exitMs)
      }, remaining)
    }

    const animContainer = animRef.current
    let animInstance: AnimationItem | null = null

    if (animContainer) {
      animInstance = lottie.loadAnimation({
        container: animContainer,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: '/components/BlobLoad.json',
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
        },
      })
    }

    const finishTimer = window.setTimeout(() => {
      finish()
    }, 1600)

    return () => {
      window.clearTimeout(finishTimer)
      animInstance?.destroy()
    }
  }, [])

  if (isDone) {
    return <>{children}</>
  }

  return (
    <div className={isExiting ? 'preload preload--exit' : 'preload'}>
      <div className="preloadGlow" />

      <div className="preloadContent">
        <div
          ref={animRef}
          className="preloadAnim"
          aria-hidden="true"
        />

        <div className="preloadBrand">
          RECEPTA
        </div>

        <div className="preloadTagline">
          AI RECEPTIONIST
        </div>

        <div className="preloadStatus">
          <span className="preloadStatusDot" />
          Preparing your workspace
        </div>
      </div>
    </div>
  )
}
