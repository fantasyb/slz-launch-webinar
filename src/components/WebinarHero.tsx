import React from 'react';
import CountdownTimer from './CountdownTimer';
import RegistrationForm from './RegistrationForm';
import { motion } from 'framer-motion';

const WebinarHero = () => {
  const handleRegistration = async (data: { name: string; email: string }) => {
    // This will be implemented later with your backend
    console.log('Registration data:', data);
  };

  return (
    <section className="relative pt-24 pb-16 overflow-hidden">
      {/* Background Elements */}
      <motion.div 
        className="absolute inset-0 overflow-hidden pointer-events-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5 }}
      >
        <motion.div 
          className="absolute -top-1/2 -right-1/2 w-full h-full bg-[#02524b]/5 rounded-full blur-3xl"
          animate={{ 
            scale: [1, 1.1, 1],
            opacity: [0.5, 0.6, 0.5] 
          }}
          transition={{ 
            duration: 8,
            repeat: Infinity,
            repeatType: "reverse" 
          }}
        />
        <motion.div 
          className="absolute -bottom-1/2 -left-1/2 w-full h-full bg-[#02524b]/5 rounded-full blur-3xl"
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.5, 0.7, 0.5] 
          }}
          transition={{ 
            duration: 10,
            repeat: Infinity,
            repeatType: "reverse" 
          }}
        />
      </motion.div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-[#02524b] mb-4">
            Smart List Zero
          </h1>
          <p className="text-xl md:text-2xl text-gray-600 max-w-3xl mx-auto">
            Finally see who's claiming leads, their pipeline progress, and smart list 
            activity - all in one powerful dashboard.
          </p>
        </motion.div>

        <div className="mb-12">
          <CountdownTimer />
        </div>

        <div className="max-w-md mx-auto">
          <RegistrationForm onSubmit={handleRegistration} />
        </div>
      </div>
    </section>
  );
};

export default WebinarHero;