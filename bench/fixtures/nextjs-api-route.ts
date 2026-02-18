import { NextResponse } from 'next/server';

interface CreateItemBody {
  name: string;
  description?: string;
  tags?: string[];
}

interface Item {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
}

const items: Item[] = [];

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  let results = items;

  if (query) {
    const lowerQuery = query.toLowerCase();
    results = items.filter(
      (item) =>
        item.name.toLowerCase().includes(lowerQuery) ||
        item.description.toLowerCase().includes(lowerQuery)
    );
  }

  const paged = results.slice(offset, offset + limit);

  return NextResponse.json({
    data: paged,
    total: results.length,
    limit,
    offset,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: CreateItemBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ error: 'Field "name" is required' }, { status: 400 });
  }

  const newItem: Item = {
    id: crypto.randomUUID(),
    name: body.name.trim(),
    description: body.description?.trim() ?? '',
    tags: body.tags ?? [],
    createdAt: new Date().toISOString(),
  };

  items.push(newItem);

  return NextResponse.json(newItem, { status: 201 });
}
