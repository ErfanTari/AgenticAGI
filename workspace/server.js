import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

const app = express();
const PORT = 3000;

const CACHE_FILE_PATH = path.join(process.cwd(), 'cache.json');
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

async function fetchAndFormatHackerNewsData() {
    try {
        console.log('Fetching fresh data from HackerNews API...');

        // Fetch top story IDs
        const topStoriesResponse = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
        if (!topStoriesResponse.ok) {
            throw new Error(`Failed to fetch top story IDs: ${topStoriesResponse.statusText}`);
        }
        const storyIds = await topStoriesResponse.json();

        // Take the first 5 story IDs
        const top5Ids = storyIds.slice(0, 5);

        // Create promises to fetch details for each of the 5 stories
        const storyPromises = top5Ids.map(id =>
            fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(res => {
                if (!res.ok) {
                    throw new Error(`Failed to fetch story ${id}: ${res.statusText}`);
                }
                return res.json();
            })
        );

        // Fetch all 5 stories concurrently
        const stories = await Promise.all(storyPromises);

        // Extract required fields
        const headlines = stories.map(story => ({
            title: story.title,
            url: story.url,
            score: story.score,
        }));

        return headlines;
    } catch (error) {
        console.error('Error fetching HackerNews data:', error);
        // Re-throw to be caught by the route handler
        throw error;
    }
}

app.get('/news', async (req, res) => {
    try {
        // Check if cache file exists
        try {
            const stats = await fs.stat(CACHE_FILE_PATH);
            const cacheAge = Date.now() - stats.mtime.getTime();

            // If cache is still valid, serve from cache
            if (cacheAge < CACHE_DURATION_MS) {
                console.log('Serving from cache.');
                const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
                return res.json(JSON.parse(cachedData));
            }
            console.log('Cache is stale.');
        } catch (error) {
            // If file doesn't exist (ENOENT), it's not an error, we just need to fetch
            if (error.code !== 'ENOENT') {
                throw error; // For other errors, re-throw
            }
            console.log('Cache file not found.');
        }
        
        // If cache is old or doesn't exist, fetch fresh data
        const headlines = await fetchAndFormatHackerNewsData();

        // Write the new data to the cache file
        await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(headlines, null, 2), 'utf-8');
        console.log('Cache has been updated.');

        // Return the fresh data
        res.json(headlines);

    } catch (error) {
        console.error('An error occurred in the /news endpoint:', error);
        res.status(500).json({ error: 'Failed to retrieve news headlines.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});