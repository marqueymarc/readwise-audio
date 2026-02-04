/**
 * Mock Readwise API Response
 * Based on real curl capture
 */

export const mockReadwiseList = async (req) => {
    console.log('[Mock Readwise] serving list request');

    // Real captured data structure
    const results = [
        {
            "id": "01kg2v32rr4p7bd5zh4zzsbx9g",
            "url": "https://read.readwise.io/read/01kg2v32rr4p7bd5zh4zzsbx9g",
            "title": "Handling ICErubes Safely",
            "author": "The Bloom County Boys by Berkeley Breathed",
            "source": null,
            "category": "email",
            "location": "feed",
            "tags": {},
            "site_name": "Patreon",
            "word_count": 58,
            "reading_time": "1 min",
            "created_at": "2026-01-28T17:40:47.562434+00:00",
            "updated_at": "2026-01-28T17:40:48.050128+00:00",
            "published_date": "2026-01-28",
            "summary": null,
            "image_url": null,
            "content": null,
            "source_url": "mailto:reader-forwarded-email/b48ede080817db057690e37a55be3655",
            "notes": "",
            "parent_id": null,
            "reading_progress": 0,
            "first_opened_at": null,
            "last_opened_at": null,
            "saved_at": "2026-01-28T17:40:47.512000+00:00",
            "last_moved_at": "2026-01-28T17:40:47.512000+00:00"
        },
        {
            "id": "01kg2p7xwgmc735p4356a4fajf",
            "url": "https://read.readwise.io/read/01kg2p7xwgmc735p4356a4fajf",
            "title": "Trump’s ‘Year Zero’ Is Over. Now Comes the Reckoning",
            "author": "Matt Bai",
            "source": "Reader Share Sheet iOS",
            "category": "article",
            "location": "later",
            "tags": {},
            "site_name": "Rolling Stone",
            "word_count": 1786,
            "reading_time": "7 mins",
            "created_at": "2026-01-28T16:16:03.496750+00:00",
            "updated_at": "2026-02-04T00:55:46.900976+00:00",
            "published_date": "2026-01-16",
            "summary": "Donald Trump’s second term brought a harsh and radical change to America...",
            "image_url": "https://www.rollingstone.com/wp-content/uploads/2026/01/R1408_NATAFF_Trump_VoterRemorse_A-copy.jpg?w=1600&h=900&crop=1",
            "content": null,
            "source_url": "https://www.rollingstone.com/politics/political-commentary/trump-year-zero-reckoning-1235500008/",
            "notes": "",
            "parent_id": null,
            "reading_progress": 0.39,
            "saved_at": "2026-01-28T16:16:03.472000+00:00",
            "last_moved_at": "2026-01-31T01:42:20.446000+00:00"
        },
        {
            "id": "archived-article-id",
            "title": "Old News",
            "location": "archive",
            "category": "article"
        }
    ];

    return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
};

export const mockReadwiseUpdate = async (req) => {
    const url = new URL(req.url);
    const id = url.pathname.split('/')[4]; // /api/v3/update/{id}/
    console.log(`[Mock Readwise] updating article ${id}`);

    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
};

export const mockReadwiseDelete = async (req) => {
    const url = new URL(req.url);
    const id = url.pathname.split('/')[4]; // /api/v3/delete/{id}/
    console.log(`[Mock Readwise] deleting article ${id}`);

    return new Response(JSON.stringify({ success: true }), { status: 204 });
};
