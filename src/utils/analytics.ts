type EventAction = 
  | 'registration_complete'
  | 'registration_start'
  | 'registration_error'  // Added this
  | 'video_play'
  | 'video_pause'
  | 'video_complete'
  | 'feature_click';

export const trackEvent = (
  action: EventAction,
  category: string,
  label: string,
  value?: number
) => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', action, {
      event_category: category,
      event_label: label,
      value: value
    });
  }
};

export const trackRegistration = (email: string) => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', 'registration_complete', {
      event_category: 'engagement',
      event_label: 'webinar_signup',
      email_domain: email.split('@')[1]
    });
  }
};

export const trackVideoInteraction = (action: 'play' | 'pause' | 'complete') => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', `video_${action}`, {
      event_category: 'engagement',
      event_label: 'overview_video'
    });
  }
};