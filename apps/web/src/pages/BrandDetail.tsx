import { useParams } from 'react-router-dom';

export default function BrandDetail() {
  const { slug } = useParams<{ slug: string }>();
  return <main style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}><h1>Brand: {slug}</h1><p>Detail view coming soon.</p></main>;
}
