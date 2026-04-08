import { useParams } from 'react-router-dom'

export default function MenuPage() {
  const { slug } = useParams()
  return <div>Menu page for: {slug}</div>
}
