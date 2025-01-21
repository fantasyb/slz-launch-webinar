'use client';

import Image from "next/image";
import { motion } from "framer-motion";
import CountdownTimer from '@/components/CountdownTimer';
import RegistrationForm from '@/components/RegistrationForm';
import { BarChart2, Users, ArrowRightLeft, Brain, Trophy, ActivitySquare } from 'lucide-react';
import Navigation from '@/components/Navigation';  // Add this import

export default function Home() {
  const handleRegistration = async (data: { name: string; email: string }) => {
    console.log('Registration data:', data);
  };

  return (
    <div className="relative min-h-screen">
      {/* Hero Section with Rich Background */}
      <div className="relative overflow-hidden bg-gradient-to-b from-slate-950 via-[#02524b] to-white">
        {/* Background Elements for Hero Only */}
        <div className="absolute inset-0 overflow-hidden">
          <div 
            className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"
          />
          
          <motion.div 
            className="absolute top-0 left-0 w-[800px] h-[800px] rounded-full bg-gradient-to-r from-blue-500/20 to-cyan-500/20 blur-3xl"
            animate={{ 
              scale: [1, 1.2, 1],
              x: [-200, 0, -200],
              y: [-200, 0, -200]
            }}
            transition={{ 
              duration: 15,
              repeat: Infinity,
              repeatType: "reverse" 
            }}
          />
          <motion.div 
            className="absolute top-0 right-0 w-[800px] h-[800px] rounded-full bg-gradient-to-r from-emerald-500/20 to-teal-500/20 blur-3xl"
            animate={{ 
              scale: [1, 1.2, 1],
              x: [200, 0, 200],
              y: [-200, 0, -200]
            }}
            transition={{ 
              duration: 15,
              repeat: Infinity,
              repeatType: "reverse" 
            }}
          />
        </div>

        {/* Navigation - Glass Effect */}
        <Navigation />

        {/* Hero Content */}
        <div className="relative pt-32 pb-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <section className="text-center relative space-y-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="space-y-8"
              >
                {/* Premium Label */}
                <motion.div 
                  className="inline-flex items-center gap-2 px-4 py-2 bg-white/[0.03] backdrop-blur-sm rounded-full text-white text-sm border border-white/[0.05]"
                  whileHover={{ scale: 1.05 }}
                  transition={{ type: "spring", stiffness: 400, damping: 10 }}
                >
                  <span className="flex gap-2 items-center">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                    </span>
                    Live Webinar • Wednesday Feb 12 @ 1PM EST
                  </span>
                </motion.div>

                <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-white">
                  Smart List Zero
                </h1>
                
                <p className="text-xl text-white/90 max-w-3xl mx-auto">
                  Finally see who&apos;s claiming leads, their pipeline progress, and smart list 
                  activity - all in one powerful dashboard.
                </p>

                {/* Countdown Timer */}
                <div>
                  <CountdownTimer />
                </div>

                {/* Registration Form */}
                <div className="max-w-md mx-auto">
                  <RegistrationForm onSubmit={handleRegistration} />
                </div>
              </motion.div>
            </section>
          </div>
        </div>
      </div>

{/* Rest of the content with light theme */}
<main className="bg-white">
  <div className="max-w-7xl mx-auto px-8 sm:px-12 lg:px-16 py-24">
    {/* Section Header */}
    <div className="text-center mb-16">
      <h2 className="text-3xl font-bold text-gray-900 mb-4">
        What You&apos;ll Learn
      </h2>
      <p className="text-xl text-gray-600 max-w-3xl mx-auto">
        Discover how Smart List Zero helps your team maintain a healthy pipeline and maximize lead engagement
      </p>
    </div>

    {/* Feature Cards */}
    <section className="mb-16">
      <div className="grid md:grid-cols-3 gap-8">
        {[
          {
            icon: BarChart2,
            title: "Complete Pipeline Visibility",
            description: "See your entire team's sales activities, response times, and pipeline health all in one dashboard"
          },
          {
            icon: Users,
            title: "Lead Claims Dashboard",
            description: "Track who's claiming leads and monitor engagement patterns to ensure no lead falls through the cracks"
          },
          {
            icon: ArrowRightLeft,
            title: "Smart List Analytics",
            description: "Monitor smart list counts and identify opportunities needing attention"
          },
          {
            icon: Brain,
            title: "AI-Powered Insights",
            description: "Get actionable recommendations based on your team's activity patterns and performance metrics"
          },
          {
            icon: Trophy,
            title: "Live Leaderboard",
            description: "Motivate your team with real-time rankings based on engagement scores and pipeline health"
          },
          {
            icon: ActivitySquare,
            title: "Performance Metrics",
            description: "Track claim-to-contact ratios, response times, and pipeline progression velocity"
          }
        ].map((feature, index) => (
          <motion.div
            key={feature.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="bg-white rounded-xl p-6 hover:shadow-lg transition-all duration-300"
          >
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-[#02524b]/5 rounded-lg p-2">
                <feature.icon className="h-6 w-6 text-[#02524b]" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">
                {feature.title}
              </h3>
            </div>
            <p className="text-gray-600 text-sm leading-relaxed">
              {feature.description}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  </div>
</main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <motion.div 
              className="flex items-center gap-2"
              whileHover={{ scale: 1.02 }}
            >
              <Image 
                src="/AmplifiedSolutions_Logo-V2_Main.png"
                alt="Amplified Solutions Logo"
                width={144}
                height={48}
                className="h-12 w-auto"
              />
            </motion.div>
            <p className="text-gray-500 text-sm">
              © 2025 Amplified Solutions Consulting LLC. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}