import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <h1>Status Board</h1>
      <ul>
        <li><Link href="/about">About</Link></li>
      </ul>
    </main>
  );
}
