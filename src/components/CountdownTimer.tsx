import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

type TimeLeft = {
  days: number;
  hours: number;
  minutes: number;
  isExpired: boolean;
};

const WEBINAR_DATE = new Date('2025-02-12T13:00:00-05:00');

const CountdownTimer = () => {
  const [timeLeft, setTimeLeft] = useState<TimeLeft>({ 
    days: 0, 
    hours: 0, 
    minutes: 0,
    isExpired: false 
  });

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date();
      const difference = WEBINAR_DATE.getTime() - now.getTime();

      if (difference <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, isExpired: true });
        return;
      }

      const days = Math.floor(difference / (1000 * 60 * 60 * 24));
      const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));

      setTimeLeft({ days, hours, minutes, isExpired: false });
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 60000);
    return () => clearInterval(timer);
  }, []);

  const padNumber = (num: number) => num.toString().padStart(2, '0');

  if (timeLeft.isExpired) {
    return (
      <div className="w-full max-w-4xl mx-auto">
        <div className="bg-black/20 backdrop-blur-sm rounded-xl p-8">
          <div className="text-center">
            <div className="text-2xl text-white font-bold mb-2">
              Webinar is Live!
            </div>
            <div className="text-white/80">
              Join us now to not miss any more content
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="bg-black/20 backdrop-blur-sm rounded-xl p-8">
        <div className="flex justify-center items-center gap-4">
          {/* Days */}
          <motion.div 
            className="text-center flex flex-col items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <motion.div 
              key={timeLeft.days}
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="text-6xl md:text-7xl lg:text-8xl font-bold text-white leading-none"
            >
              {padNumber(timeLeft.days)}
            </motion.div>
            <div className="text-sm uppercase tracking-wider text-white/80 mt-2">Days</div>
          </motion.div>

          {/* Colon */}
          <div className="text-5xl md:text-6xl lg:text-7xl font-bold text-white self-start mt-4">:</div>

          {/* Hours */}
          <motion.div 
            className="text-center flex flex-col items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <motion.div 
              key={timeLeft.hours}
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="text-6xl md:text-7xl lg:text-8xl font-bold text-white leading-none"
            >
              {padNumber(timeLeft.hours)}
            </motion.div>
            <div className="text-sm uppercase tracking-wider text-white/80 mt-2">Hours</div>
          </motion.div>

          {/* Colon */}
          <div className="text-5xl md:text-6xl lg:text-7xl font-bold text-white self-start mt-4">:</div>

          {/* Minutes */}
          <motion.div 
            className="text-center flex flex-col items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <motion.div 
              key={timeLeft.minutes}
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="text-6xl md:text-7xl lg:text-8xl font-bold text-white leading-none"
            >
              {padNumber(timeLeft.minutes)}
            </motion.div>
            <div className="text-sm uppercase tracking-wider text-white/80 mt-2">Minutes</div>
          </motion.div>
        </div>

        <div className="text-center mt-6">
          <div className="text-lg text-white font-medium">
            WEDNESDAY FEB 12 @ 1PM EST
          </div>
        </div>
      </div>
    </div>
  );
};

export default CountdownTimer;