import { SocialMentionTracker } from '../src/scanner/socialMentionTracker';

describe('SocialMentionTracker filtered stream integration', () => {
  it('ingests filtered stream payloads and records influencer mentions for tracked tokens', () => {
    const tracker = new SocialMentionTracker({
      influencerMinFollowers: 10_000,
    });
    tracker.registerTrackedToken('mint-1', 'TEST', ['test', 'mint-1']);

    const matched = tracker.consumeFilteredStreamLine(JSON.stringify({
      data: {
        id: 'tweet-1',
        text: 'Breaking TEST momentum on Solana',
        author_id: 'user-1',
      },
      includes: {
        users: [
          {
            id: 'user-1',
            username: 'alpha',
            public_metrics: {
              followers_count: 50_000,
            },
          },
        ],
      },
    }));

    expect(matched).toBe(1);
    expect(tracker.getMentionData('mint-1')).toMatchObject({
      mentionCount: 1,
      influencerMentions: 1,
    });
  });

  it('does not start filtered stream without bearer token', async () => {
    const tracker = new SocialMentionTracker();
    tracker.registerTrackedToken('mint-1', 'TEST');

    await expect(tracker.startFilteredStream()).resolves.toBe(false);
  });
});
