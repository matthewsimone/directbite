import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

export default function ImageUpload({ currentImageUrl, bucketName, storagePath, onUpload, placeholder = 'Upload Photo' }) {
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [preview, setPreview] = useState(currentImageUrl || null)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file || !supabase) return

    // Reset input so the same file can be re-selected on retry
    e.target.value = ''

    const ext = file.name.split('.').pop().toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      setError('Please select a JPEG, PNG, or WebP image')
      return
    }

    setUploading(true)
    setProgress(0)
    setError(null)

    // Show local preview immediately
    const localUrl = URL.createObjectURL(file)
    setPreview(localUrl)

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
      URL.revokeObjectURL(localUrl)
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

    URL.revokeObjectURL(localUrl)
  }

  return (
    <div>
      <div className="flex items-center gap-4">
        {/* Preview */}
        <div className="w-20 h-20 rounded-lg overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
          {preview ? (
            <img src={preview} alt="Preview" className="w-full h-full object-cover" />
          ) : (
            <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          )}
        </div>

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
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  )
}
