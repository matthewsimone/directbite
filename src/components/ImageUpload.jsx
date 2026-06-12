/*
 * TODO (priority: medium) - Improve image quality for menu items
 * Issue: Menu item images currently uploaded at small resolutions (~160×160 observed in production)
 * - There is NO client-side downscaling in this code; uploads are direct passthrough to Supabase Storage
 * - The small images come from the tablet camera/photo picker or are pre-shrunk by the user before upload
 * - Featured menu items on the website render at 440 device px on retina, so 160px sources upscale 2.75×
 * Possible fixes:
 * - Add client-side resize/quality enforcement before upload (target: at least 800×800)
 * - Show recommended dimensions in upload UI ("Use photos at least 800px on each side")
 * - Reject uploads below a minimum resolution
 * - Use Supabase Storage transformations to serve consistent resolution
 * Affects: src/pages/website/components/FeaturedMenu.jsx (and customer ordering page item images)
 * Related commit: 3e3787c (added img-crisp CSS as a band-aid)
 */

import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

export default function ImageUpload({ currentImageUrl, bucketName, storagePath, onUpload, placeholder = 'Upload Photo', accept = 'image', maxSizeMB = null }) {
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [preview, setPreview] = useState(currentImageUrl || null)
  const [error, setError] = useState(null)
  const [fileName, setFileName] = useState('')
  const fileRef = useRef(null)

  const ACCEPT_CONFIG = {
    image: { exts: ['jpg', 'jpeg', 'png', 'webp'], inputAccept: 'image/jpeg,image/png,image/webp', label: 'JPEG, PNG, or WebP image' },
    pdf:   { exts: ['pdf'], inputAccept: 'application/pdf', label: 'PDF' },
  }
  const cfg = ACCEPT_CONFIG[accept] || ACCEPT_CONFIG.image

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file || !supabase) return

    // Reset input so the same file can be re-selected on retry
    e.target.value = ''

    const ext = file.name.split('.').pop().toLowerCase()
    if (!cfg.exts.includes(ext)) {
      setError(`Please select a ${cfg.label}`)
      return
    }

    if (maxSizeMB && file.size > maxSizeMB * 1024 * 1024) {
      setError(`File must be under ${maxSizeMB} MB`)
      return
    }

    setUploading(true)
    setProgress(0)
    setError(null)

    setFileName(file.name)

    // Show local preview immediately (image mode only; PDFs use the icon + name)
    let localUrl = null
    if (accept !== 'pdf') {
      localUrl = URL.createObjectURL(file)
      setPreview(localUrl)
    }

    const filePath = storagePath.replace(/\.[^.]+$/, '') + '.' + ext

    // Simulate progress since supabase-js doesn't expose upload progress
    const progressInterval = setInterval(() => {
      setProgress(prev => Math.min(prev + 15, 90))
    }, 200)

    const { error: uploadErr } = await supabase.storage
      .from(bucketName)
      .upload(filePath, file, { upsert: true })

    clearInterval(progressInterval)

    if (uploadErr) {
      console.error(`Upload to ${bucketName}/${filePath} failed:`, uploadErr.message, uploadErr)
      setPreview(currentImageUrl || null)
      setUploading(false)
      setProgress(0)
      setError(`Upload failed: ${uploadErr.message}`)
      if (localUrl) URL.revokeObjectURL(localUrl)
      return
    }

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath)

    const publicUrl = urlData.publicUrl + '?t=' + Date.now()
    setPreview(publicUrl)
    setProgress(100)
    setUploading(false)
    onUpload(publicUrl)

    if (localUrl) URL.revokeObjectURL(localUrl)
  }

  return (
    <div>
      <div className="flex items-center gap-4">
        {/* Preview */}
        {accept === 'pdf' ? (
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-20 h-20 rounded-lg overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-sm text-gray-600 truncate">
              {fileName || (currentImageUrl ? 'PDF uploaded' : '')}
            </span>
          </div>
        ) : (
          <div className="w-20 h-20 rounded-lg overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
            {preview ? (
              <img src={preview} alt="Preview" className="w-full h-full object-cover" />
            ) : (
              <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}

        <div className="flex-1">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-4 h-9 bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : placeholder}
          </button>

          {/* Progress bar */}
          {uploading && (
            <div className="mt-2 w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#16A34A] rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {/* Error message */}
          {error && (
            <p className="mt-1 text-xs text-red-500">{error}</p>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={cfg.inputAccept}
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  )
}
