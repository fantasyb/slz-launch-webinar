// app/api/register/route.ts
import { NextRequest, NextResponse } from 'next/server';

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_API_KEY;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_API_SECRET;
const ZOOM_WEBINAR_ID = process.env.ZOOM_WEBINAR_ID;
const FUB_API_KEY = process.env.FUB_API_KEY;

async function getZoomAccessToken() {
  try {
    const tokenUrl = 'https://zoom.us/oauth/token';
    const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');

    const response = await fetch(
      `${tokenUrl}?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      console.error('Zoom token error:', error);
      throw new Error('Failed to get Zoom access token');
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Token acquisition error:', error);
    throw error;
  }
}

async function registerForWebinar(accessToken: string, email: string, name: string) {
  const response = await fetch(
    `https://api.zoom.us/v2/webinars/${ZOOM_WEBINAR_ID}/registrants`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' ') || '',
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    console.error('Zoom registration error:', error);
    throw new Error('Failed to register for webinar');
  }

  return response.json();
}

async function checkExistingFUBContact(email: string) {
  const fubCredentials = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  
  try {
    // Search for people with the exact email
    const response = await fetch(`https://api.followupboss.com/v1/people?emails=${encodeURIComponent(email)}`, {
      headers: {
        'Authorization': `Basic ${fubCredentials}`,
        'Content-Type': 'application/json',
      }
    });

    const data = await response.json();
    console.log('FUB search response:', data);
    
    if (!response.ok) {
      console.error('FUB search error:', data);
      throw new Error('Failed to search FUB contacts');
    }

    // Check if we have any matching people
    if (data && Array.isArray(data) && data.length > 0) {
      return data[0]; // Return the first matching person
    }

    return null; // No matching person found
  } catch (error) {
    console.error('FUB search error:', error);
    throw error;
  }
}

async function createFUBEvent(email: string, name: string, isExisting: boolean) {
  const fubCredentials = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  
  try {
    // Prepare the event payload
    const eventPayload: any = {
      type: 'Registration',
      person: {
        emails: [{ value: email }],
        name: name,
        tags: ['SLZ Launch Webinar']
      },
      message: 'Registered for Smart List Zero Launch Webinar',
      description: `Registered for webinar on Wednesday Feb 12 @ 1PM EST`,
      occurredAt: new Date().toISOString()
    };

    // Only add source for new contacts
    if (!isExisting) {
      eventPayload.source = 'SLZ Launch Webinar';
      eventPayload.system = 'Webinar Registration';
    }

    const response = await fetch('https://api.followupboss.com/v1/events', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${fubCredentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventPayload)
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('FUB error:', data);
      throw new Error('Failed to create/update FUB contact');
    }

    return data;
  } catch (error) {
    console.error('FUB integration error:', error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET || !ZOOM_WEBINAR_ID || !FUB_API_KEY) {
      console.error('Missing required credentials');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { email, name } = body;

    if (!email || !name) {
      return NextResponse.json(
        { error: 'Email and name are required' },
        { status: 400 }
      );
    }

    // Get Zoom access token
    const accessToken = await getZoomAccessToken();
    console.log('Got Zoom access token');

    // Register for webinar
    const zoomRegistration = await registerForWebinar(accessToken, email, name);
    console.log('Zoom registration successful');

    // Check if contact exists in FUB
    const existingContact = await checkExistingFUBContact(email);
    console.log('Existing contact check:', existingContact ? 'Found' : 'Not found');

    // Create/Update FUB contact
    const fubResponse = await createFUBEvent(email, name, !!existingContact);
    console.log('FUB integration successful');

    return NextResponse.json({
      success: true,
      join_url: zoomRegistration.join_url,
      registrant_id: zoomRegistration.registrant_id,
      fub_status: fubResponse.status,
      isExistingContact: !!existingContact
    });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { error: 'Registration failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}