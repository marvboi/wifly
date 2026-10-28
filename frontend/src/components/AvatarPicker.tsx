import { useRef, useState } from 'react'
import { avatarProblem } from '../api/client'
import { WiflyFace } from './Bits'
import { Icon } from './Icon'

import { AVATAR_TYPES as TYPES } from '../api/client'

/** Profile photo picker: a dashed circle ("add photo") until a photo is set, then the photo with change / remove. */
export function AvatarPicker({ src, name, handle, onPick, onRemove, onError, size = 88 }: {
  src: string | null; name: string; handle: string; size?: number
  onPick: (f: File) => Promise<void> | void; onRemove: () => void; onError: (msg: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const open = () => input.current?.click()
  const face = !!(name.trim() || handle)
  const choose = async (f?: File) => {
    if (input.current) input.current.value = ''
    if (!f) return
    const bad = avatarProblem(f)
    if (bad) return onError(bad)
    setBusy(true)
    try { await onPick(f) } finally { setBusy(false) }
  }
  return (
    <div className="avpick">
      <button type="button" className={`avpick__circle ${src ? 'has-photo' : ''}`} style={{ width: size, height: size }} onClick={open} disabled={busy}
        aria-label={src ? 'change profile photo' : 'add a profile photo (optional)'}>
        {src ? <img src={src} alt="" />
          : face ? <span className="avpick__face"><WiflyFace size={size} /></span>
            : <span className="avpick__empty"><Icon name="camera" size={22} /></span>}
        {(src || face) && <span className="avpick__cam" aria-hidden="true"><Icon name="camera" size={13} /></span>}
        {busy && <span className="avpick__busy" aria-hidden="true" />}
      </button>
      {src && <div className="avpick__actions"><button type="button" className="linkbtn tiny" onClick={onRemove}>remove</button></div>}
      <input ref={input} type="file" accept={TYPES.join(',')} onChange={e => choose(e.target.files?.[0])} hidden />
    </div>
  )
}
