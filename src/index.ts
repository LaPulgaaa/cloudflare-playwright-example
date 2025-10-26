import { launch } from '@cloudflare/playwright';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface NotionContent {
  title: string;
  content: string;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/scrape') {
      return new Response(
        JSON.stringify({ error: 'Use /scrape endpoint with ?url=<notion-url>' }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const notionUrl = url.searchParams.get('url');

    if (!notionUrl) {
      return new Response(
        JSON.stringify({ error: 'Missing "url" query parameter' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    // Validate that it's a Notion URL
    if (!notionUrl.includes('notion.so') && !notionUrl.includes('notion.site')) {
      return new Response(
        JSON.stringify({ error: 'Invalid Notion URL. Must be from notion.so or notion.site' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    let browser;
    try {
      browser = await launch(env.MYBROWSER);
      const page = await browser.newPage();

      // Navigate to the Notion page
      await page.goto(notionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for Notion content to load
      await page.waitForSelector('[data-content-editable-root="true"]', { timeout: 5000 });

      // Expand all collapsed content blocks (toggles) - optimized for speed
      try {
        const toggleSelector = '.layout [role="button"][aria-expanded="false"]';

        const clickAllCollapsed = async () => {
          return await page.evaluate((sel) => {
            const nodes = Array.from(document.querySelectorAll(sel));
            let clickedCount = 0;

            for (const node of nodes) {
              if (!node || !node.isConnected) continue;
              const rect = node.getBoundingClientRect();
              const visible =
                rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0;
              if (!visible) continue;
              const disabled = node.getAttribute('aria-disabled') === 'true';
              if (disabled) continue;

              // Click without scrolling to save time
              node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              clickedCount++;
            }

            return clickedCount;
          }, toggleSelector);
        };

        // Click all toggles in batches with shorter waits
        let iteration = 0;
        const maxIterations = 20; // Reduced from 100
        let lastClickCount = -1;

        while (iteration < maxIterations) {
          const clickedCount = await clickAllCollapsed();

          // Early exit if no toggles were clicked or same as last time
          if (clickedCount === 0 || clickedCount === lastClickCount) break;

          lastClickCount = clickedCount;
          await page.waitForTimeout(100); // Reduced from 500ms
          iteration++;
        }
      } catch (error) {
        console.log('Could not expand collapsed content:', error);
      }

      // Shorter final wait for content to settle
      await page.waitForTimeout(500); // Reduced from 2000ms

      // Extract the page content - text only, no images/links/embeds
      const extractedData = await page.evaluate(() => {
        // Get the title
        const titleElement = document.querySelector('.notion-page-content .notion-header__title, [data-content-editable-leaf="true"]');
        const title = titleElement?.textContent?.trim() || 'Untitled';

        // Get all text content from the page
        const contentRoot = document.querySelector('[data-content-editable-root="true"]');

        if (!contentRoot) {
          return { title, content: '' };
        }

        // Extract text content from all blocks, excluding images and other media
        const allBlocks = Array.from(contentRoot.querySelectorAll('[data-block-id]'));

        // Filter to only top-level blocks (not nested inside other blocks)
        // This prevents duplicate content from nested blocks
        const topLevelBlocks = allBlocks.filter((block) => {
          // Check if this block is nested inside another block
          const parent = block.parentElement?.closest('[data-block-id]');
          // Only include if no parent block exists in our list
          return !parent || !allBlocks.includes(parent);
        });

        const contentParts: string[] = [];

        topLevelBlocks.forEach((block) => {
          const blockElement = block as HTMLElement;

          // Skip image blocks, embed blocks, and other non-text content
          if (
            blockElement.querySelector('img') ||
            blockElement.querySelector('[class*="image"]') ||
            blockElement.querySelector('[class*="embed"]') ||
            blockElement.querySelector('[class*="video"]') ||
            blockElement.querySelector('[class*="file"]') ||
            blockElement.querySelector('svg')
          ) {
            return;
          }

          // Clone the block to manipulate it without affecting the page
          const clone = blockElement.cloneNode(true) as HTMLElement;

          // Remove any remaining images, links, or media elements
          clone.querySelectorAll('img, svg, video, audio, iframe').forEach(el => el.remove());

          // Get pure text content
          const text = clone.textContent?.trim();

          if (text && text.length > 0) {
            contentParts.push(text);
          }
        });

        return {
          title,
          content: contentParts.join('\n\n'),
        };
      });

      await browser.close();

      const result: NotionContent = {
        title: extractedData.title,
        content: extractedData.content,
      };

      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });

    } catch (error) {
      if (browser) {
        await browser.close();
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return new Response(
        JSON.stringify({
          error: 'Failed to scrape Notion page',
          details: errorMessage
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }
  },
};
