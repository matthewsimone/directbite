import { useParams } from 'react-router-dom'

export default function TabletPage() {
  const { slug } = useParams()
  return <div>Tablet interface for: {slug}</div>
}
