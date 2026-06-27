"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Sun, Moon, RotateCcw, Clock, Target, Crosshair, Camera, Check, Heart } from 'lucide-react';
import { playClickSound, playPinchSound, playSwapSound, playVictorySound, playResetSound } from '@/utils/synth';
import { motion, AnimatePresence } from 'framer-motion';

interface DifficultyConfig {
  id: string;
  label: string;
  grid: number;
}

// Difficulty configurations
const DIFFICULTIES: Record<string, DifficultyConfig> = {
  EASY: { id: 'easy', label: 'Easy', grid: 3 }
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function App() {
  // Scripts Loading State
  const [mpLoaded, setMpLoaded] = useState(false);
  const [mpError, setMpError] = useState<any>(null);
  
  // Game State
  const [phase, setPhase] = useState('menu'); // menu, capture, solve
  const [difficulty, setDifficulty] = useState<DifficultyConfig>(DIFFICULTIES.EASY);
  const [timer, setTimer] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [showVictoryModal, setShowVictoryModal] = useState(false);
  const [bestTime, setBestTime] = useState<number | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  
  // Puzzle State
  const [pieces, setPieces] = useState<any[]>([]);
  const [draggedPiece, setDraggedPiece] = useState<any>(null);
  const [puzzleAspectRatio, setPuzzleAspectRatio] = useState(16 / 9);
  
  // MediaPipe / Tracking Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  
  // Normalized crop box state {x, y, width, height} - defaults to center 60%
  const cropBoxRef = useRef({ x: 0.2, y: 0.15, width: 0.6, height: 0.7 });
  
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0, pinching: false });
  const [captureProgress, setCaptureProgress] = useState(0); // For 2-hand pinch detection
  const [isReady, setIsReady] = useState(false);

  // Schmitt Trigger / Hysteresis pinch tracking to prevent threshold flickering
  const isPinchingRef = useRef(false);
  const wasPinchingRef = useRef(false);
  const syncDraggedPieceRef = useRef<any>(null);
  const smoothedCursorRef = useRef({ x: 0, y: 0 });
  const gridRectRef = useRef<DOMRect | null>(null);
  const lastHoveredSlotIdxRef = useRef<number | null>(null);
  const hasDraggedRef = useRef(false);

  // Use refs for values that change frequently to avoid stale closures in MediaPipe callbacks
  const phaseRef = useRef(phase);
  const cursorPosRef = useRef({ x: 0, y: 0, pinching: false });
  const draggedPieceRef = useRef(draggedPiece);
  const piecesRef = useRef(pieces);
  const difficultyRef = useRef(difficulty);

  useEffect(() => { 
    phaseRef.current = phase; 
    // Clear rect cache on phase change
    gridRectRef.current = null;
    lastHoveredSlotIdxRef.current = null;
  }, [phase]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      gridRectRef.current = null;
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => { cursorPosRef.current = cursorPos; }, [cursorPos]);
  useEffect(() => { draggedPieceRef.current = draggedPiece; }, [draggedPiece]);
  useEffect(() => { piecesRef.current = pieces; }, [pieces]);
  useEffect(() => { difficultyRef.current = difficulty; }, [difficulty]);

  // Load theme + personal best time on mount (Client-only)
  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem('puzzlehands-theme') as 'light' | 'dark' | null;
      const initialTheme = storedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      setTheme(initialTheme);
      document.documentElement.classList.toggle('dark', initialTheme === 'dark');

      const storedBest = localStorage.getItem('puzzlehands-best-time');
      if (storedBest) setBestTime(parseInt(storedBest, 10));
    } catch {}
  }, []);

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('puzzlehands-theme', next);
      } catch {}
      document.documentElement.classList.toggle('dark', next === 'dark');
      return next;
    });
  };

  // Check Win Condition when pieces state updates (Reliable, race-condition free)
  useEffect(() => {
    if (phase !== 'solve' || pieces.length === 0) return;
    
    const isWin = pieces.every(p => p.currentIdx === p.originalIdx);
    if (isWin) {
      handleWin();
    }
  }, [pieces, phase]);

  // Dynamically load MediaPipe scripts (Client-only)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = reject;
      document.body.appendChild(script);
    });

    const init = async () => {
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
        setMpLoaded(true);
      } catch (err) {
        console.error('Failed to load MediaPipe from scripts:', err);
        setMpError(err);
      }
    };
    init();
  }, []);



  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isTimerRunning) {
      interval = setInterval(() => setTimer((prev) => prev + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [isTimerRunning]);

  // Crops and generates puzzle pieces from the rectangular box area
  const generatePuzzle = (videoEl: HTMLVideoElement) => {
    const grid = difficulty.grid;
    
    // Video dimensions
    const videoW = videoEl.videoWidth || 640;
    const videoH = videoEl.videoHeight || 480;
    
    // Retrieve crop bounding box
    const crop = cropBoxRef.current;
    const cropX = crop.x * videoW;
    const cropY = crop.y * videoH;
    const cropW = crop.width * videoW;
    const cropH = crop.height * videoH;
    
    const aspect = cropW / cropH;
    setPuzzleAspectRatio(aspect || 16 / 9);

    const canvas = document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Mirror the cropped segment
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(
      videoEl,
      cropX, cropY, cropW, cropH, // source region
      0, 0, cropW, cropH          // destination canvas
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset scale/translation
    
    const pieceWidth = cropW / grid;
    const pieceHeight = cropH / grid;
    const newPieces = [];

    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const pCanvas = document.createElement('canvas');
        pCanvas.width = pieceWidth;
        pCanvas.height = pieceHeight;
        const pCtx = pCanvas.getContext('2d');
        if (pCtx) {
          pCtx.drawImage(
            canvas,
            x * pieceWidth, y * pieceHeight, pieceWidth, pieceHeight,
            0, 0, pieceWidth, pieceHeight
          );
        }
        
        const id = y * grid + x;
        newPieces.push({
          id,
          originalIdx: id,
          currentIdx: id,
          imgUrl: pCanvas.toDataURL('image/jpeg', 0.8)
        });
      }
    }

    // Shuffle
    let shuffled = [...newPieces];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // Assign new currentIdx
    shuffled = shuffled.map((p, idx) => ({ ...p, currentIdx: idx }));
    
    setPieces(shuffled);
    setPhase('solve');
    setTimer(0);
    setIsTimerRunning(true);
  };

  const handleWin = () => {
    setIsTimerRunning(false);
    playVictorySound();

    // Trigger confetti explosion for victory celebration!
    import('canvas-confetti').then((confetti) => {
      confetti.default({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.6 },
        colors: ['#D9703C', '#3C6E5E', '#F2E9D8', '#E2935E']
      });
    });

    setTimeout(() => {
      setShowVictoryModal(true);
      setBestTime(prev => {
        const next = prev === null ? timer : Math.min(prev, timer);
        try {
          localStorage.setItem('puzzlehands-best-time', String(next));
        } catch {}
        return next;
      });
    }, 1000);
  };

  const handlePlayAgain = () => {
    playClickSound();
    setShowVictoryModal(false);
    setPhase('capture');
    setIsReady(false);
    setIsTimerRunning(false);
    setDraggedPiece(null);
    syncDraggedPieceRef.current = null;
    smoothedCursorRef.current = { x: 0, y: 0 };
  };

  const handleBackToMenuFromVictory = () => {
    playResetSound();
    setShowVictoryModal(false);
    setPhase('menu');
  };

  const onResults = useCallback((results: any) => {
    const currentPhase = phaseRef.current;
    if (currentPhase === 'menu') return;

    const videoWidth = videoRef.current?.videoWidth || 640;
    const videoHeight = videoRef.current?.videoHeight || 480;

    // Adjust canvas dimensions if mounted
    if (canvasRef.current) {
      if (canvasRef.current.width !== videoWidth) {
        canvasRef.current.width = videoWidth;
        canvasRef.current.height = videoHeight;
      }
    }

    // Evaluate Bounding box coordinates if 2 hands are present
    if (results.multiHandLandmarks && results.multiHandLandmarks.length === 2 && currentPhase === 'capture') {
      const hand1 = results.multiHandLandmarks[0][8]; // Index finger tip
      const hand2 = results.multiHandLandmarks[1][8]; // Index finger tip
      
      const xMin = Math.min(hand1.x, hand2.x);
      const xMax = Math.max(hand1.x, hand2.x);
      const yMin = Math.min(hand1.y, hand2.y);
      const yMax = Math.max(hand1.y, hand2.y);

      // Enforce a flexible, safe bounding box width/height
      const cropW = Math.max(0.12, Math.min(0.95, xMax - xMin));
      const cropH = Math.max(0.12, Math.min(0.95, yMax - yMin));
      const cropX = Math.max(0.02, Math.min(0.98 - cropW, xMin));
      const cropY = Math.max(0.02, Math.min(0.98 - cropH, yMin));

      cropBoxRef.current = { x: cropX, y: cropY, width: cropW, height: cropH };
    }

    // Draw HUD overlays during capture phase and hand skeleton during both capture/solve phases
    if ((currentPhase === 'capture' || currentPhase === 'solve') && canvasRef.current) {
      const canvasCtx = canvasRef.current.getContext('2d');
      if (canvasCtx) {
        const width = canvasRef.current.width;
        const height = canvasRef.current.height;
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, width, height);

        // Draw MediaPipe tracked landmarks
        if (results.multiHandLandmarks && (window as any).drawConnectors && (window as any).drawLandmarks) {
          for (const landmarks of results.multiHandLandmarks) {
            (window as any).drawConnectors(canvasCtx, landmarks, (window as any).HAND_CONNECTIONS, { 
              color: currentPhase === 'solve' ? '#3C6E5E' : 'rgba(217, 112, 60, 0.5)', 
              lineWidth: currentPhase === 'solve' ? 3 : 1.5 
            });
            (window as any).drawLandmarks(canvasCtx, landmarks, { 
              color: currentPhase === 'solve' ? '#D9703C' : '#3C6E5E', 
              lineWidth: currentPhase === 'solve' ? 2 : 1, 
              radius: currentPhase === 'solve' ? 4 : 2.5 
            });
          }
        }

        // Draw tracked crop box and scanner ONLY in capture phase
        if (currentPhase === 'capture') {
          const crop = cropBoxRef.current;
          const boxX = crop.x * width;
          const boxY = crop.y * height;
          const boxW = crop.width * width;
          const boxH = crop.height * height;

          // Warm dashed boundary box
          canvasCtx.strokeStyle = '#D9703C';
          canvasCtx.lineWidth = 3;
          canvasCtx.shadowColor = 'rgba(217, 112, 60, 0.5)';
          canvasCtx.shadowBlur = 6;
          canvasCtx.strokeRect(boxX, boxY, boxW, boxH);

          // Gentle sweeping guide line
          const scanTime = (Date.now() % 2000) / 2000;
          const laserY = boxY + boxH * scanTime;
          canvasCtx.strokeStyle = '#3C6E5E';
          canvasCtx.shadowColor = 'rgba(60, 110, 94, 0.4)';
          canvasCtx.lineWidth = 2;
          canvasCtx.beginPath();
          canvasCtx.moveTo(boxX, laserY);
          canvasCtx.lineTo(boxX + boxW, laserY);
          canvasCtx.stroke();

          // Label indicators
          canvasCtx.fillStyle = '#D9703C';
          canvasCtx.font = '600 14px sans-serif';
          canvasCtx.shadowBlur = 2;
          canvasCtx.fillText('Pinch with both hands to snap a photo', boxX, boxY - 10);
        }

        canvasCtx.restore();
      }
    }

    // Process Hand Logic
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const hands = results.multiHandLandmarks;
      
      const primaryHand = hands[0];
      const indexTip = primaryHand[8];
      const thumbTip = primaryHand[4];
      
      // Calculate viewport-relative mapping for the target container (aspect-ratio fit, cached for solve phase)
      let rect: DOMRect | null = null;
      if (currentPhase === 'capture' && videoRef.current) {
        rect = videoRef.current.getBoundingClientRect();
      } else if (currentPhase === 'solve') {
        if (!gridRectRef.current && gridContainerRef.current) {
          const currentRect = gridContainerRef.current.getBoundingClientRect();
          if (currentRect.width > 0 && currentRect.height > 0) {
            gridRectRef.current = currentRect;
          }
        }
        rect = gridRectRef.current;
      }

      // Cursor position coordinates
      let x = 0;
      let y = 0;

      // Stable Knuckle Anchor: midpoint between index and thumb tips prevents pinch offset jumps
      const handX = (indexTip.x + thumbTip.x) / 2;
      const handY = (indexTip.y + thumbTip.y) / 2;

      // Get video dimensions for pixel-space isotropic calculations
      const videoWidth = videoRef.current?.videoWidth || 1280;
      const videoHeight = videoRef.current?.videoHeight || 720;

      // Scale-invariant distance using middle finger MCP to wrist as hand reference size (calculated in isotropic pixel space)
      const wrist = primaryHand[0];
      const middleMcp = primaryHand[9];
      
      const wristX = wrist.x * videoWidth;
      const wristY = wrist.y * videoHeight;
      const mcpX = middleMcp.x * videoWidth;
      const mcpY = middleMcp.y * videoHeight;
      const handSizePixels = Math.hypot(wristX - mcpX, wristY - mcpY) || 150;
      
      const p1x = indexTip.x * videoWidth;
      const p1y = indexTip.y * videoHeight;
      const p2x = thumbTip.x * videoWidth;
      const p2y = thumbTip.y * videoHeight;
      const distPixels = Math.hypot(p1x - p2x, p1y - p2y);
      const normalizedDist = distPixels / handSizePixels;
      
      let isPinching = isPinchingRef.current;
      
      // Hysteresis thresholding in isotropic physical-ratio space
      if (isPinching) {
        if (normalizedDist > 0.48) { // release threshold
          isPinching = false;
        }
      } else {
        if (normalizedDist < 0.22) { // activation threshold
          isPinching = true;
        }
      }
      isPinchingRef.current = isPinching;

      // Tracking box range (middle 50% of camera width and height) for doubled tracking sensitivity
      const trackingBox = { xMin: 0.25, xMax: 0.75, yMin: 0.25, yMax: 0.75 };
      const normalizedHandX = (handX - trackingBox.xMin) / (trackingBox.xMax - trackingBox.xMin);
      const normalizedHandY = (handY - trackingBox.yMin) / (trackingBox.yMax - trackingBox.yMin);
      const clampedHandX = Math.max(0, Math.min(1, normalizedHandX));
      const clampedHandY = Math.max(0, Math.min(1, normalizedHandY));

      if (rect) {
        x = rect.left + (1 - clampedHandX) * rect.width;
        y = rect.top + clampedHandY * rect.height;
      } else {
        x = (1 - clampedHandX) * window.innerWidth;
        y = clampedHandY * window.innerHeight;
      }

      // Exponential moving average (EMA) smoothing filter to eliminate cursor jitter
      const smoothFactor = 0.25;
      if (smoothedCursorRef.current.x === 0 && smoothedCursorRef.current.y === 0) {
        smoothedCursorRef.current = { x, y };
      } else {
        smoothedCursorRef.current.x += (x - smoothedCursorRef.current.x) * smoothFactor;
        smoothedCursorRef.current.y += (y - smoothedCursorRef.current.y) * smoothFactor;
      }

      const finalX = smoothedCursorRef.current.x;
      const finalY = smoothedCursorRef.current.y;

      setCursorPos({ x: finalX, y: finalY, pinching: isPinching });

      // PHASE 1: CAPTURE LOGIC (Requires 2 hands pinching)
      if (currentPhase === 'capture') {
        if (hands.length === 2) {
          const hand2 = hands[1];
          const hand2Wrist = hand2[0];
          const hand2Mcp = hand2[9];
          
          const h2WristX = hand2Wrist.x * videoWidth;
          const h2WristY = hand2Wrist.y * videoHeight;
          const h2McpX = hand2Mcp.x * videoWidth;
          const h2McpY = hand2Mcp.y * videoHeight;
          const hand2SizePixels = Math.hypot(h2WristX - h2McpX, h2WristY - h2McpY) || 150;
          
          const h2p1x = hand2[8].x * videoWidth;
          const h2p1y = hand2[8].y * videoHeight;
          const h2p2x = hand2[4].x * videoWidth;
          const h2p2y = hand2[4].y * videoHeight;
          const dist2Pixels = Math.hypot(h2p1x - h2p2x, h2p1y - h2p2y);
          const normalizedDist2 = dist2Pixels / hand2SizePixels;
          
          const hand2Pinching = normalizedDist2 < 0.22;
          
          if (isPinching && hand2Pinching) {
            setCaptureProgress(prev => {
              if (prev >= 100) {
                if (videoRef.current) {
                  generatePuzzle(videoRef.current);
                }
                return 0; // reset
              }
              return prev + 5;
            });
          } else {
            setCaptureProgress(prev => Math.max(0, prev - 10));
          }
        } else {
           setCaptureProgress(0);
        }
      }

      // PHASE 2: SOLVE LOGIC (Direct Mathematical grid index swaps)
      if (currentPhase === 'solve') {
        const wasPinching = wasPinchingRef.current;
        const curDragged = syncDraggedPieceRef.current;
        const gridDimension = difficultyRef.current.grid;

        // Calculate hovered grid row and column directly from raw hand position for instant, lag-free selection and drop
        const col = Math.floor((1 - clampedHandX) * gridDimension);
        const row = Math.floor(clampedHandY * gridDimension);

        const clampedCol = Math.max(0, Math.min(gridDimension - 1, col));
        const clampedRow = Math.max(0, Math.min(gridDimension - 1, row));
        const hoveredSlotIdx = clampedRow * gridDimension + clampedCol;
        
        // Cache the last hovered slot index to handle dropout drops
        lastHoveredSlotIdxRef.current = hoveredSlotIdx;

        // Transition: Not pinching -> Pinching (PICKUP)
        if (isPinching && !wasPinching && !curDragged) {
          // Find the piece currently placed in this slot index
          const piece = piecesRef.current.find(p => p.currentIdx === hoveredSlotIdx);
          if (piece) {
             setDraggedPiece(piece);
             syncDraggedPieceRef.current = piece;
             playPinchSound();
          }
        } 
        // Transition: Pinching -> Not pinching (DROP)
        else if (!isPinching && wasPinching && curDragged) {
          // Find the target piece currently placed in this slot index
          const targetPiece = piecesRef.current.find(p => p.currentIdx === hoveredSlotIdx);
          
          if (targetPiece && targetPiece.id !== curDragged.id) {
             setPieces(prev => {
               const newArr = prev.map(p => ({ ...p }));
               const i1 = newArr.findIndex(p => p.id === curDragged.id);
               const i2 = newArr.findIndex(p => p.id === targetPiece.id);
               
               if (i1 !== -1 && i2 !== -1) {
                 const tempIdx = newArr[i1].currentIdx;
                 newArr[i1].currentIdx = newArr[i2].currentIdx;
                 newArr[i2].currentIdx = tempIdx;
               }
               
               piecesRef.current = newArr;
               return newArr;
             });
             playSwapSound();
          }
          setDraggedPiece(null);
          syncDraggedPieceRef.current = null;
        }

        // Sync wasPinchingRef
        wasPinchingRef.current = isPinching;
      }
    } else {
      setCursorPos(prev => ({ ...prev, pinching: false }));
      if (phaseRef.current === 'capture') setCaptureProgress(0);
      
      // If hand is lost while dragging in solve phase, perform a fallback drop on the last known hovered slot
      if (phaseRef.current === 'solve' && syncDraggedPieceRef.current) {
        const curDragged = syncDraggedPieceRef.current;
        const lastHoveredSlot = lastHoveredSlotIdxRef.current;
        
        if (lastHoveredSlot !== null) {
          const targetPiece = piecesRef.current.find(p => p.currentIdx === lastHoveredSlot);
          if (targetPiece && targetPiece.id !== curDragged.id) {
             setPieces(prev => {
               const newArr = prev.map(p => ({ ...p }));
               const i1 = newArr.findIndex(p => p.id === curDragged.id);
               const i2 = newArr.findIndex(p => p.id === targetPiece.id);
               
               if (i1 !== -1 && i2 !== -1) {
                 const tempIdx = newArr[i1].currentIdx;
                 newArr[i1].currentIdx = newArr[i2].currentIdx;
                 newArr[i2].currentIdx = tempIdx;
               }
               
               piecesRef.current = newArr;
               return newArr;
             });
             playSwapSound();
          }
        }
        setDraggedPiece(null);
        syncDraggedPieceRef.current = null;
      }
      
      isPinchingRef.current = false;
      wasPinchingRef.current = false;
      hasDraggedRef.current = false;
      smoothedCursorRef.current = { x: 0, y: 0 };
    }
  }, []);

  const onResultsRef = useRef(onResults);
  useEffect(() => {
    onResultsRef.current = onResults;
  }, [onResults]);

  // Main Camera & MediaPipe Initialization Effect (Runs ONCE on loaded)
  useEffect(() => {
    if (!mpLoaded || !videoRef.current) return;

    let active = true;

    if (!handsRef.current && (window as any).Hands) {
      const hands = new (window as any).Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
      });

      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
      });

      hands.onResults((results: any) => {
        if (active) onResultsRef.current(results);
      });
      handsRef.current = hands;
    }

    if (!cameraRef.current && (window as any).Camera) {
      const camera = new (window as any).Camera(videoRef.current, {
        onFrame: async () => {
          const currentPhase = phaseRef.current;
          // Keep frame updates running only when capture or solve screens are active
          if (videoRef.current && handsRef.current && active && (currentPhase === 'capture' || currentPhase === 'solve')) {
            const video = videoRef.current;
            // Prevent WebAssembly crash: verify readyState and positive dimensions
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
              try {
                await handsRef.current.send({ image: video });
              } catch (e) {
                console.error('MediaPipe send frame error:', e);
              }
            }
          }
        },
        width: 640,
        height: 480
      });
      camera.start().then(() => {
        if (active) setIsReady(true);
      });
      cameraRef.current = camera;
    }

    return () => {
      // Clean up thread on component unmount
      active = false;
      setIsReady(false);
      if (cameraRef.current) {
        try { cameraRef.current.stop(); } catch {}
        cameraRef.current = null;
      }
      if (handsRef.current) {
        try { handsRef.current.close(); } catch {}
        handsRef.current = null;
      }
    };
  }, [mpLoaded]);

  const handleDragStart = (piece: any) => {
    if (phase !== 'solve') return;
    const curDragged = syncDraggedPieceRef.current;
    
    if (curDragged === null) {
      setDraggedPiece(piece);
      syncDraggedPieceRef.current = piece;
      lastHoveredSlotIdxRef.current = piece.currentIdx;
      hasDraggedRef.current = false;
      playPinchSound();
    } else {
      // Second click fallback (Click-to-swap)
      if (curDragged.id !== piece.id) {
        setPieces(prev => {
          const newArr = [...prev];
          const i1 = newArr.findIndex(p => p.id === curDragged.id);
          const i2 = newArr.findIndex(p => p.id === piece.id);
          
          const tempIdx = newArr[i1].currentIdx;
          newArr[i1].currentIdx = newArr[i2].currentIdx;
          newArr[i2].currentIdx = tempIdx;
          
          piecesRef.current = newArr;
          return newArr;
        });
        playSwapSound();
      }
      setDraggedPiece(null);
      syncDraggedPieceRef.current = null;
      hasDraggedRef.current = false;
    }
  };

  const handleDragEnter = (slotIdx: number) => {
    if (phase !== 'solve') return;
    if (syncDraggedPieceRef.current) {
      lastHoveredSlotIdxRef.current = slotIdx;
    }
  };

  const handleDragEnd = useCallback(() => {
    const curDragged = syncDraggedPieceRef.current;
    const lastHoveredSlot = lastHoveredSlotIdxRef.current;
    const hasDragged = hasDraggedRef.current;
    
    if (curDragged && lastHoveredSlot !== null) {
      if (hasDragged) {
        if (lastHoveredSlot !== curDragged.currentIdx) {
          const targetPiece = piecesRef.current.find(p => p.currentIdx === lastHoveredSlot);
          if (targetPiece) {
            setPieces(prev => {
              const newArr = [...prev];
              const i1 = newArr.findIndex(p => p.id === curDragged.id);
              const i2 = newArr.findIndex(p => p.id === targetPiece.id);
              
              const tempIdx = newArr[i1].currentIdx;
              newArr[i1].currentIdx = newArr[i2].currentIdx;
              newArr[i2].currentIdx = tempIdx;
              
              piecesRef.current = newArr;
              return newArr;
            });
            playSwapSound();
          }
        }
        // Always clear dragged state if they actually dragged
        setDraggedPiece(null);
        syncDraggedPieceRef.current = null;
      }
    }
    hasDraggedRef.current = false;
  }, []);

  const handleGlobalMouseMove = useCallback((e: MouseEvent) => {
    if (phaseRef.current !== 'solve' || !syncDraggedPieceRef.current) return;
    
    // Smoothly update cursorPos so dragged piece thumbnail follows mouse cursor in mouse mode
    setCursorPos({ x: e.clientX, y: e.clientY, pinching: true });
    
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (element) {
      const slotEl = element.closest('[data-slot-idx]');
      if (slotEl) {
        const slotIdx = parseInt(slotEl.getAttribute('data-slot-idx') || '', 10);
        if (!isNaN(slotIdx)) {
          lastHoveredSlotIdxRef.current = slotIdx;
          if (slotIdx !== syncDraggedPieceRef.current.currentIdx) {
            hasDraggedRef.current = true;
          }
        }
      }
    }
  }, []);

  const handleGlobalTouchMove = useCallback((e: TouchEvent) => {
    if (phaseRef.current !== 'solve' || !syncDraggedPieceRef.current) return;
    const touch = e.touches[0];
    
    // Smoothly update cursorPos so dragged piece thumbnail follows touch cursor
    setCursorPos({ x: touch.clientX, y: touch.clientY, pinching: true });
    
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    if (element) {
      const slotEl = element.closest('[data-slot-idx]');
      if (slotEl) {
        const slotIdx = parseInt(slotEl.getAttribute('data-slot-idx') || '', 10);
        if (!isNaN(slotIdx)) {
          lastHoveredSlotIdxRef.current = slotIdx;
          if (slotIdx !== syncDraggedPieceRef.current.currentIdx) {
            hasDraggedRef.current = true;
          }
        }
      }
    }
  }, []);

  const handleTouchStart = (piece: any, e: React.TouchEvent) => {
    e.preventDefault(); // Prevents simulated mouse events
    handleDragStart(piece);
  };

  const handleDragEndRef = useRef(handleDragEnd);
  useEffect(() => {
    handleDragEndRef.current = handleDragEnd;
  }, [handleDragEnd]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const handleGlobalMouseUp = () => {
      if (syncDraggedPieceRef.current) {
        handleDragEndRef.current();
      }
    };
    
    const onMouseMove = (e: MouseEvent) => handleGlobalMouseMove(e);
    const onTouchMove = (e: TouchEvent) => handleGlobalTouchMove(e);

    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('touchend', handleGlobalMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove, { passive: true });

    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('touchend', handleGlobalMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, [handleGlobalMouseMove, handleGlobalTouchMove]);

  const handleManualCapture = () => {
    playClickSound();
    if (videoRef.current) {
      generatePuzzle(videoRef.current);
    }
  };

  const renderCursor = () => {
    if (phase !== 'solve' && phase !== 'capture') return null;
    if (cursorPos.x === 0 && cursorPos.y === 0) return null;

    return (
      <div 
        className="fixed pointer-events-none z-50 flex items-center justify-center transition-all duration-75 ease-linear"
        style={{ 
          left: cursorPos.x, 
          top: cursorPos.y, 
          transform: 'translate(-50%, -50%)',
          width: cursorPos.pinching ? '40px' : '60px',
          height: cursorPos.pinching ? '40px' : '60px',
        }}
      >
        <div className={`absolute inset-0 rounded-full border-2 border-[var(--accent)] transition-all duration-150 ${cursorPos.pinching ? 'bg-[var(--accent)]/35 scale-75' : 'bg-transparent scale-100'} shadow-[0_2px_10px_var(--shadow)]`} />
        {phase === 'solve' && draggedPiece && (
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1.15, opacity: 0.9 }}
            className="absolute rounded-xl overflow-hidden border-2 border-[var(--accent)] shadow-[0_4px_16px_var(--shadow)] pointer-events-none z-50 w-28 h-28"
            style={{
              left: 45,
              top: 45,
            }}
          >
             <div 
               className="w-full h-full bg-cover bg-center"
               style={{ backgroundImage: `url(${draggedPiece.imgUrl})`}}
             />
          </motion.div>
        )}
      </div>
    );
  };

  const renderMenu = () => (
    <div className="flex flex-col items-center justify-center h-full space-y-10 animate-fade-in z-10 relative px-6">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-soft)] mb-2 animate-soft-bob">
          <span className="text-3xl">✋</span>
        </div>
        <h1 className="font-display text-5xl sm:text-6xl font-semibold tracking-tight text-[var(--ink)]">
          Puzzle Hands
        </h1>
        <p className="text-[var(--ink-soft)] text-base max-w-sm mx-auto">
          Take a quick selfie with two hands, then pinch the pieces back into place — no mouse, just your hands in front of the camera.
        </p>
      </div>

      {bestTime !== null && (
        <div className="flex items-center gap-2 text-sm text-[var(--ink-soft)] bg-[var(--surface)] border border-[var(--border)] rounded-full px-4 py-2">
          <Heart size={14} className="text-[var(--accent)]" fill="var(--accent)" />
          Your best time so far: <span className="font-semibold text-[var(--ink)]">{formatTime(bestTime)}</span>
        </div>
      )}

      <div className="flex gap-3">
        {Object.values(DIFFICULTIES).map((diff) => (
          <button
            key={diff.id}
            onClick={() => { setDifficulty(diff); playClickSound(); }}
            className={`px-5 py-2.5 rounded-full border-2 font-semibold text-sm transition-all duration-200 ${
              difficulty.id === diff.id
                ? 'border-[var(--accent)] text-[var(--accent-ink)] bg-[var(--accent)] scale-105'
                : 'border-[var(--border)] text-[var(--ink-soft)] hover:border-[var(--accent)] hover:text-[var(--ink)] bg-[var(--surface)]'
            }`}
          >
            {diff.label} · {diff.grid}×{diff.grid}
          </button>
        ))}
      </div>

      <button
        onClick={() => { setPhase('capture'); playClickSound(); }}
        className="group relative px-9 py-4 bg-[var(--accent)] rounded-2xl overflow-hidden hover:brightness-105 active:scale-[0.98] transition-all shadow-[0_4px_14px_var(--shadow)]"
      >
        <div className="relative flex items-center gap-3 text-[var(--accent-ink)] font-semibold text-base">
          <Play size={20} fill="currentColor" />
          Let&apos;s play
        </div>
      </button>
    </div>
  );


  return (
    <div className="relative w-full h-screen bg-[var(--bg)] font-sans overflow-hidden text-[var(--ink)] selection:bg-[var(--accent)] selection:text-[var(--accent-ink)] flex items-center justify-center transition-colors duration-300">
      {/* Background texture — soft paper grain, no glow */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-15%] left-[-10%] w-[45%] h-[45%] rounded-full opacity-40" style={{ background: 'var(--accent-soft)', filter: 'blur(90px)' }} />
        <div className="absolute bottom-[-15%] right-[-10%] w-[50%] h-[50%] rounded-full opacity-40" style={{ background: 'var(--pine-soft)', filter: 'blur(90px)' }} />
      </div>

      {/* Theme toggle — visible on every screen */}
      <button
        onClick={() => { toggleTheme(); playClickSound(); }}
        aria-label="Toggle light and dark theme"
        className="absolute top-5 right-5 z-40 p-2.5 rounded-full bg-[var(--surface)] border border-[var(--border)] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:border-[var(--accent)] transition-colors shadow-[0_2px_8px_var(--shadow)]"
      >
        {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
      </button>

      {!mpLoaded && phase === 'menu' && (
        <div className="absolute inset-0 z-50 bg-[var(--bg)] flex flex-col items-center justify-center space-y-4">
          <div className="w-10 h-10 border-4 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin"></div>
          <p className="text-[var(--ink-soft)] text-sm">Getting the camera tools ready…</p>
        </div>
      )}

      {mpError && (
        <div className="absolute inset-0 z-50 bg-[var(--bg)]/90 backdrop-blur-md flex items-center justify-center">
           <div className="bg-[var(--surface)] p-6 rounded-2xl border border-[var(--border)] max-w-md text-center space-y-3">
              <p className="text-[var(--ink)] font-semibold">Couldn&apos;t load the hand-tracking tools.</p>
              <p className="text-sm text-[var(--ink-soft)]">Check your internet connection or ad-blocker, then refresh the page.</p>
           </div>
        </div>
      )}

      {/* Persistent Virtual Cursor */}
      {renderCursor()}

      {/* Main Content Router */}
      {phase === 'menu' && renderMenu()}

      {/* Game Phases Container (Capture / Solve) */}
      <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center transition-opacity duration-500 ${phase === 'capture' || phase === 'solve' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        
        {/* Top UI Bar */}
        <div className="absolute top-6 w-full max-w-6xl px-6 flex justify-between items-start z-30 pointer-events-none">
           <div className="pointer-events-auto">
             <button 
               onClick={() => { setPhase('menu'); setIsReady(false); setIsTimerRunning(false); setDraggedPiece(null); syncDraggedPieceRef.current = null; smoothedCursorRef.current = { x: 0, y: 0 }; playResetSound(); }}
               className="p-3 bg-[var(--surface)]/90 backdrop-blur-md border border-[var(--border)] rounded-full text-[var(--ink-soft)] hover:text-[var(--ink)] hover:border-[var(--accent)] transition-colors shadow-[0_2px_8px_var(--shadow)]"
             >
                <RotateCcw size={20} />
             </button>
           </div>

           {phase === 'solve' && (
             <div className="flex flex-col items-center">
               <div className="flex items-center gap-2 bg-[var(--surface)]/90 backdrop-blur-md border border-[var(--border)] px-6 py-2 rounded-full shadow-[0_2px_8px_var(--shadow)]">
                 <Clock size={16} className={isTimerRunning ? 'text-[var(--accent)]' : 'text-[var(--ink-soft)]'} />
                 <span className={`font-display text-xl font-semibold tracking-wide ${isTimerRunning ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}>
                   {formatTime(timer)}
                 </span>
               </div>
             </div>
           )}

           <div className="bg-[var(--surface)]/90 backdrop-blur-md border border-[var(--border)] rounded-xl p-4 text-sm w-64 shadow-[0_2px_8px_var(--shadow)]">
             {phase === 'capture' ? (
               <>
                 <div className="text-[var(--accent)] font-semibold mb-2 flex items-center gap-2">
                   <Target size={14} /> Step 1 — Take a photo
                 </div>
                 <ol className="text-[var(--ink-soft)] space-y-1.5 list-decimal pl-4">
                   <li>Get yourself in frame.</li>
                   <li>Show both hands to the camera.</li>
                   <li><strong className="text-[var(--ink)]">Pinch with both hands</strong> at once to snap a photo.</li>
                   <li><span className="text-xs text-[var(--accent)] block mt-1">Or just tap the button below.</span></li>
                 </ol>
               </>
             ) : (
               <>
                 <div className="text-[var(--accent)] font-semibold mb-2 flex items-center gap-2">
                   <Crosshair size={14} /> Step 2 — Solve it
                 </div>
                 <ol className="text-[var(--ink-soft)] space-y-1.5 list-decimal pl-4">
                   <li>Move your hand to steer the cursor.</li>
                   <li><strong className="text-[var(--ink)]">Pinch and hold</strong> to pick up a piece.</li>
                   <li>Drag it over another piece and let go to swap.</li>
                 </ol>
               </>
             )}
           </div>
        </div>

        {/* Video / Canvas Container */}
        <div className="absolute inset-0 w-full h-full bg-[var(--bg-soft)] flex items-center justify-center overflow-hidden">
          
          {!isReady && (phase === 'capture' || phase === 'solve') && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-soft)] z-20">
               <div className="animate-fade-in text-[var(--ink-soft)]">Switching on the camera…</div>
            </div>
          )}

          <video 
            ref={videoRef} 
            className={`w-full h-full object-cover transform scale-x-[-1] ${phase === 'capture' || phase === 'solve' ? 'opacity-100' : 'opacity-0 absolute inset-0'}`} 
            playsInline autoPlay muted 
          />
          
          {(phase === 'capture' || phase === 'solve') && (
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover transform scale-x-[-1] pointer-events-none z-30" />
          )}

          {phase === 'capture' && (
             <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex flex-col items-center gap-3">
                <button
                  onClick={handleManualCapture}
                  disabled={!isReady}
                  className="px-6 py-3 rounded-full bg-[var(--accent)] hover:brightness-105 text-[var(--accent-ink)] font-semibold text-sm transition-all disabled:opacity-50 flex items-center gap-2 shadow-[0_4px_14px_var(--shadow)]"
                >
                  <Camera size={16} />
                  Or just tap here to snap
                </button>
             </div>
          )}

          {phase === 'capture' && captureProgress > 0 && (
             <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-sm transition-all">
                <div className="flex flex-col items-center space-y-4">
                  <div className="w-32 h-32 rounded-full border-4 border-[var(--border)] flex items-center justify-center relative bg-[var(--surface)]">
                     <svg className="absolute inset-0 transform -rotate-90 w-full h-full">
                       <circle cx="64" cy="64" r="60" stroke="var(--accent)" strokeWidth="8" fill="none" strokeDasharray="377" strokeDashoffset={377 - (377 * captureProgress) / 100} className="transition-all duration-100 ease-linear" />
                     </svg>
                     <Target className="text-[var(--accent)]" size={40} />
                  </div>
                  <p className="text-[var(--ink)] font-semibold">Hold still, snapping…</p>
                </div>
             </div>
          )}

          {/* Puzzle Grid Area (Phase 2) */}
          {phase === 'solve' && pieces.length > 0 && (
            <div className="absolute inset-0 z-10 bg-transparent flex items-center justify-center p-8">
              <div 
                ref={gridContainerRef}
                className="relative border-2 border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-[0_6px_24px_var(--shadow)] rounded-lg"
                style={{
                  width: '90vw',
                  height: 'calc(90vw / var(--aspect-ratio))',
                  maxWidth: 'calc(70vh * var(--aspect-ratio))',
                  maxHeight: '70vh',
                  ['--aspect-ratio' as any]: puzzleAspectRatio,
                }}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) {
                    setDraggedPiece(null);
                    syncDraggedPieceRef.current = null;
                  }
                }}
              >
                {pieces.map((piece) => {
                  const gridDimension = difficulty.grid;
                  const row = Math.floor(piece.currentIdx / gridDimension);
                  const col = piece.currentIdx % gridDimension;
                  
                  const widthPct = 100 / gridDimension;
                  const heightPct = 100 / gridDimension;
                  
                  const isDragged = draggedPiece?.id === piece.id;
                  
                  return (
                    <motion.div
                      key={`piece-${piece.id}`}
                      layout
                      transition={{
                        type: 'spring',
                        stiffness: 300,
                        damping: 24
                      }}
                      className={`absolute overflow-hidden group cursor-pointer border ${isDragged ? 'border-[var(--accent)] z-20 shadow-[0_4px_16px_var(--shadow)]' : 'border-transparent z-10'}`}
                      style={{
                        width: `calc(${widthPct}% - 2px)`,
                        height: `calc(${heightPct}% - 2px)`,
                        left: `${col * widthPct}%`,
                        top: `${row * heightPct}%`,
                        margin: '1px',
                      }}
                      data-slot-idx={piece.currentIdx}
                      onMouseDown={(e) => {
                        if (e.button === 0) {
                          handleDragStart(piece);
                        }
                      }}
                      onTouchStart={(e) => {
                        handleTouchStart(piece, e);
                      }}
                    >
                      <div 
                        className={`absolute inset-0 transition-opacity duration-200 ${isDragged ? 'opacity-30 grayscale' : 'opacity-100'}`}
                      >
                         <div 
                           className="w-full h-full bg-cover bg-center"
                           style={{ backgroundImage: `url(${piece.imgUrl})`}}
                         />
                         <div className="absolute inset-0 border border-[var(--border)]/40 group-hover:border-[var(--accent)]/50 transition-colors pointer-events-none" />
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Victory Modal */}
      <AnimatePresence>
        {showVictoryModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/40 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.92, y: 16, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.92, y: 16, opacity: 0 }}
              className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] p-7 rounded-3xl flex flex-col relative shadow-[0_10px_40px_var(--shadow)] text-[var(--ink)]"
            >
              <div className="text-center mb-6">
                <div className="inline-flex p-3 rounded-full bg-[var(--pine-soft)] text-[var(--pine)] mb-3 animate-gentle-pop">
                  <Check className="w-8 h-8" />
                </div>
                <h3 className="font-display text-2xl font-semibold text-[var(--ink)]">
                  You solved it!
                </h3>
                <p className="text-sm text-[var(--ink-soft)] mt-1">
                  Nicely done putting it back together.
                </p>
              </div>

              {/* Stats Box */}
              <div className="grid grid-cols-2 gap-3 bg-[var(--bg-soft)] border border-[var(--border)] rounded-2xl p-4 mb-6 text-center">
                <div className="flex flex-col">
                  <span className="text-xs text-[var(--ink-soft)] font-medium">
                    Your time
                  </span>
                  <span className="text-xl font-semibold text-[var(--ink)] mt-0.5">{formatTime(timer)}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-[var(--ink-soft)] font-medium">
                    Best time
                  </span>
                  <span className="text-xl font-semibold text-[var(--accent)] mt-0.5">
                    {bestTime !== null ? formatTime(Math.min(bestTime, timer)) : formatTime(timer)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <button
                  onClick={handlePlayAgain}
                  className="w-full py-3.5 rounded-2xl bg-[var(--accent)] text-[var(--accent-ink)] font-semibold hover:brightness-105 active:scale-[0.98] transition-all"
                >
                  Play again
                </button>
                <button
                  onClick={handleBackToMenuFromVictory}
                  className="w-full py-3 rounded-2xl bg-transparent text-[var(--ink-soft)] font-medium hover:text-[var(--ink)] transition-colors text-sm"
                >
                  Back to menu
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Credit footer — shown on every screen */}
      <a
        href="https://teendev8.netlify.app"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 text-xs text-[var(--ink-soft)] hover:text-[var(--accent)] transition-colors px-3 py-1 rounded-full bg-[var(--surface)]/70 backdrop-blur-sm border border-[var(--border)]/60"
      >
        Made by Rajveer Pakhale · TeenDev
      </a>
    </div>
  );
}
