import React, { useState, useEffect } from 'react';
import Image from "next/image";
import { motion, useScroll, useTransform} from "framer-motion";

const Navigation = () => {
  const { scrollY } = useScroll();
  const [scrollThreshold, setScrollThreshold] = useState(0);
  
  useEffect(() => {
    setScrollThreshold(window.innerHeight - 80);
    
    const handleResize = () => {
      setScrollThreshold(window.innerHeight - 80);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const backgroundColor = useTransform(
    scrollY,
    [0, scrollThreshold - 200, scrollThreshold],
    ["rgba(255, 255, 255, 0.01)", "rgba(255, 255, 255, 0.5)", "rgba(255, 255, 255, 1)"]
  );
  
  const borderColor = useTransform(
    scrollY,
    [0, scrollThreshold - 200, scrollThreshold],
    ["rgba(255, 255, 255, 0.05)", "rgba(229, 231, 235, 0.5)", "rgb(229, 231, 235)"]
  );

  const buttonBackground = useTransform(
    scrollY,
    [0, scrollThreshold - 200, scrollThreshold],
    ["rgb(255, 255, 255)", "rgb(128, 164, 160)", "rgb(2, 82, 75)"]
  );

  const buttonText = useTransform(
    scrollY,
    [0, scrollThreshold - 200, scrollThreshold],
    ["rgb(2, 82, 75)", "rgb(255, 255, 255)", "rgb(255, 255, 255)"]
  );

  const handleScrollToRegistration = () => {
    const registrationElement = document.getElementById('registration');
    if (registrationElement) {
      const elementPosition = registrationElement.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - 100; // Adjusted offset
      
      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
    }
  };

  return (
    <motion.header 
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.2 }}
      style={{
        backgroundColor,
        borderBottom: "1px solid",
        borderColor,
      }}
      className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        <motion.div 
          className="flex items-center gap-2"
          whileHover={{ scale: 1.02 }}
        >
          <motion.div 
            style={{
              filter: useTransform(
                scrollY,
                [0, scrollThreshold - 200, scrollThreshold],
                ["brightness(0) invert(1)", "brightness(0) invert(1)", "brightness(1) invert(0)"]
              )
            }}
          >
            <Image 
              src="/AmplifiedSolutions_Logo-V2_Main.png"
              alt="Amplified Solutions Logo"
              width={144}
              height={48}
              className="h-12 w-auto"
              priority
            />
          </motion.div>
        </motion.div>
        
        <motion.button
          onClick={handleScrollToRegistration}
          className="px-8 py-2 rounded-full font-medium"
          style={{
            backgroundColor: buttonBackground,
            color: buttonText,
          }}
          whileHover={{ scale: 1.05 }}
          transition={{ type: "spring", stiffness: 400, damping: 10 }}
        >
          Register Now
        </motion.button>
      </div>
    </motion.header>
  );
};

export default Navigation;