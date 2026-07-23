import { useEffect, useState } from 'react';

export default function ResizableDivider({ onResize }) {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return undefined;

    function handleMouseMove(e) {
      onResize(e.clientX);
    }

    function handleMouseUp() {
      setIsDragging(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [isDragging, onResize]);

  return (
    <div
      className={`resizable-divider ${isDragging ? 'dragging' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      title="Drag to resize sidebar width"
    />
  );
}
