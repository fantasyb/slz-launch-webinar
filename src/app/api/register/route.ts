import { NextRequest, NextResponse } from 'next/server';

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_API_KEY;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_API_SECRET;
const ZOOM_WEBINAR_ID = process.env.ZOOM_WEBINAR_ID;
const FUB_API_KEY = process.env.FUB_API_KEY;

interface FUBPerson {
  id: number;
  name: string;
  stage: string;
  tags: string[];
  emails: Array<{ value: string; type?: string; status?: string; isPrimary?: number }>;
}

interface FUBPeopleResponse {
  _metadata: {
    collection: string;
    total: number;
    offset: number;
    limit: number;
  };
  people: FUBPerson[];
}

interface ZoomRegistrant {
  email: string;
  join_url: string;
  registrant_id: string;
}

interface ZoomRegistrationResponse {
  registrants: ZoomRegistrant[];
}

// Helper function for safe JSON parsing
async function safeParseJSON(response: Response) {
  try {
    return await response.json();
  } catch {  // Remove the unused parameter entirely
    return null;
  }
}

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
      console.error('Zoom token error:', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error('Failed to get Zoom access token');
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Token acquisition error:', error);
    throw error;
  }
}

async function checkExistingZoomRegistration(accessToken: string, email: string): Promise<ZoomRegistrant | null> {
  try {
    const response = await fetch(
      `https://api.zoom.us/v2/webinars/${ZOOM_WEBINAR_ID}/registrants?email=${encodeURIComponent(email)}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        }
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      console.error('Zoom registration check failed:', {
        status: response.status,
        statusText: response.statusText,
        body: await response.text()
      });
      return null;
    }

    const data = await response.json() as ZoomRegistrationResponse;
    console.log('Zoom registration check response:', data);

    if (data.registrants?.length > 0) {
      const registrant = data.registrants.find((registrant: ZoomRegistrant) => 
        registrant.email.toLowerCase() === email.toLowerCase()
      );
      return registrant || null;
    }

    return null;
  } catch (error) {
    console.error('Zoom registration check error:', error);
    return null;
  }
}

async function registerForWebinar(accessToken: string, email: string, name: string) {
  try {
    // First check if already registered
    const existingRegistration = await checkExistingZoomRegistration(accessToken, email);
    if (existingRegistration) {
      console.log('Found existing Zoom registration:', existingRegistration);
      return existingRegistration;
    }

    // Split name and handle single name case
    const nameParts = name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '-'; // Use '-' as placeholder if no last name

    console.log('Registering with name parts:', { firstName, lastName });

    const response = await fetch(
      `https://api.zoom.us/v2/webinars/${ZOOM_WEBINAR_ID}/registrants`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          first_name: firstName,
          last_name: lastName // Will be '-' if no last name provided
        }),
      }
    );

    if (!response.ok) {
      const data = await safeParseJSON(response);
      console.error('Zoom registration error:', {
        status: response.status,
        statusText: response.statusText,
        data
      });

      // If it's a rate limit error, handle it specially
      if (response.status === 429) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }

      throw new Error(data?.message || 'Failed to register for webinar');
    }

    return await response.json();
  } catch (error) {
    console.error('Webinar registration error:', error);
    throw error;
  }
}

async function findPersonInFUB(email: string) {
  const auth = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  
  try {
    console.log('Searching for person in FUB:', email);
    const response = await fetch(
      `https://api.followupboss.com/v1/people?email=${encodeURIComponent(email)}&fields=id,emails,name,tags,stage`,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        }
      }
    );

    if (!response.ok) {
      console.error('FUB person search failed:', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error('Failed to search FUB contacts');
    }

    const data = await response.json() as FUBPeopleResponse;
    console.log('FUB search result:', data);
    
    // Check for people array in response
    if (data.people && Array.isArray(data.people) && data.people.length > 0) {
      // Prioritize Contact stage record, fallback to first record
      const contactStageRecord = data.people.find(person => person.stage === 'Contact');
      return contactStageRecord || data.people[0];
    }

    return null;
  } catch (error) {
    console.error('FUB search error:', error);
    throw error;
  }
}

async function createOrUpdateFUBEvent(email: string, name: string) {
  const auth = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  
  try {
    const existingPerson = await findPersonInFUB(email);
    console.log('FUB person search result:', existingPerson);

    if (existingPerson) {
      // Update tags if needed
      if (!existingPerson.tags?.includes('SLZ Launch Webinar')) {
        const updateResponse = await fetch(`https://api.followupboss.com/v1/people/${existingPerson.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tags: [...(existingPerson.tags || []), 'SLZ Launch Webinar']
          })
        });

        if (!updateResponse.ok) {
          console.error('Failed to update person tags:', await updateResponse.text());
        }
      }

      // Create event for existing person
      const eventPayload = {
        type: 'Registration',
        person: { id: existingPerson.id },
        message: 'Registered for Smart List Zero Launch Webinar',
        description: `Registered for webinar on Wednesday Feb 12 @ 1PM EST`,
        occurredAt: new Date().toISOString()
      };

      console.log('Creating event with payload:', eventPayload);

      const eventResponse = await fetch('https://api.followupboss.com/v1/events', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventPayload)
      });

      if (!eventResponse.ok) {
        const errorText = await eventResponse.text();
        console.error('Failed to create event:', errorText);
        throw new Error(`Failed to create event: ${errorText}`);
      }

      const eventData = await eventResponse.json();
      return { isExisting: true, person: existingPerson, event: eventData };

    } else {
      // Create new person with event
      const eventPayload = {
        type: 'Registration',
        person: {
          emails: [{ value: email }],
          name: name,
          tags: ['SLZ Launch Webinar']
        },
        message: 'Registered for Smart List Zero Launch Webinar',
        description: `Registered for webinar on Wednesday Feb 12 @ 1PM EST`,
        occurredAt: new Date().toISOString(),
        source: 'SLZ Launch Webinar',
        system: 'Webinar Registration'
      };

      const createResponse = await fetch('https://api.followupboss.com/v1/events', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventPayload)
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        console.error('Failed to create person and event:', errorText);
        throw new Error(`Failed to create person and event: ${errorText}`);
      }

      const data = await createResponse.json();
      return { isExisting: false, data };
    }
  } catch (error) {
    console.error('FUB integration error:', error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check environment variables
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET || 
        !ZOOM_WEBINAR_ID || !FUB_API_KEY) {
      const missing = [
        ['ZOOM_ACCOUNT_ID', ZOOM_ACCOUNT_ID],
        ['ZOOM_CLIENT_ID', ZOOM_CLIENT_ID],
        ['ZOOM_CLIENT_SECRET', ZOOM_CLIENT_SECRET],
        ['ZOOM_WEBINAR_ID', ZOOM_WEBINAR_ID],
        ['FUB_API_KEY', FUB_API_KEY]
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name)
        .join(', ');
      
      console.error(`Missing required environment variables: ${missing}`);
      return NextResponse.json(
        { error: 'Server configuration error', details: `Missing: ${missing}` },
        { status: 500 }
      );
    }

// Parse request body
let body;
try {
  body = await request.json();
} catch {  // Remove the unused parameter entirely
  return NextResponse.json(
    { error: 'Invalid request body' },
    { status: 400 }
  );
}

    const { email, name } = body;

    if (!email || !name) {
      return NextResponse.json(
        { error: 'Email and name are required' },
        { status: 400 }
      );
    }

    // Get Zoom token first
    const accessToken = await getZoomAccessToken();

    // Handle FUB first since that's working
    console.log('Starting FUB integration...');
    const fubResult = await createOrUpdateFUBEvent(email, name);
    console.log('FUB integration completed:', fubResult);

    // Then handle Zoom
    console.log('Starting Zoom registration...');
    try {
      const zoomRegistration = await registerForWebinar(accessToken, email, name);
      console.log('Zoom registration completed:', zoomRegistration);

      return NextResponse.json({
        success: true,
        join_url: zoomRegistration.join_url,
        registrant_id: zoomRegistration.registrant_id,
        isExistingContact: fubResult.isExisting
      });
    } catch (error: unknown) {
      // Type guard for our custom error
      if (error instanceof Error && error.message === 'RATE_LIMIT_EXCEEDED') {
        return NextResponse.json({
          success: true,
          error: 'ZOOM_RATE_LIMIT',
          message: 'You are already registered for this webinar. Please check your email for the join link.',
          isExistingContact: fubResult.isExisting
        }, { status: 200 });
      }
      throw error;
    }

  } catch (error: unknown) {
    console.error('Registration process failed:', error);
    
    return NextResponse.json(
      { 
        error: 'Registration failed', 
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}