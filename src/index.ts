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

      // Navigate to the Notion page and wait for network to be mostly idle
      await page.goto(notionUrl, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait for Notion content to load
      await page.waitForSelector('[data-content-editable-root="true"]', { timeout: 10000 });

      // Give Notion time to render toggles after initial load
      await page.waitForTimeout(1000);

      // Expand all collapsed content blocks (toggles)
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

        // Click all toggles in batches with adequate waits for content to load
        let iteration = 0;
        const maxIterations = 20;
        let lastClickCount = -1;

        while (iteration < maxIterations) {
          const clickedCount = await clickAllCollapsed();

          // Early exit if same as last time (but not on first iteration)
          if (iteration > 0 && clickedCount === lastClickCount) break;

          // If no toggles found and we've tried a few times, exit
          if (clickedCount === 0 && iteration > 2) break;

          lastClickCount = clickedCount;
          await page.waitForTimeout(300); // Wait for toggles to expand and content to load
          iteration++;
        }
      } catch (error) {
        console.log('Could not expand collapsed content:', error);
      }

      // Wait for all expanded content to fully render
      await page.waitForTimeout(1500);

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

        // Helper function to extract only direct text from an element, excluding nested blocks
        const getDirectText = (element: HTMLElement): string => {
          const clone = element.cloneNode(true) as HTMLElement;

          // Remove all nested blocks to get only direct text
          clone.querySelectorAll('[data-block-id]').forEach(el => el.remove());

          // Remove media elements
          clone.querySelectorAll('img, svg, video, audio, iframe').forEach(el => el.remove());

          return clone.textContent?.trim() || '';
        };

        // Extract text content from all blocks, excluding images and other media
        const allBlocks = Array.from(contentRoot.querySelectorAll('[data-block-id]'));
        const contentParts: string[] = [];
        const seenTexts = new Set<string>(); // Deduplicate identical text

        allBlocks.forEach((block) => {
          const blockElement = block as HTMLElement;

          // Get only the direct text of this block (not nested blocks)
          // getDirectText already removes nested blocks and media elements
          const text = getDirectText(blockElement);

          // Add to content if not empty and not already seen
          if (text.length > 0 && !seenTexts.has(text)) {
            seenTexts.add(text);
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
